import { ApplicationError } from '../../framework/core/errors.js';
import { twinKey } from '../jobs/JobTypes.js';
import type { JobPipelineApi, PipelineJob } from '../jobs/JobTypes.js';
import type { TrackerApi, TrackerProfile, TrackerPushReport } from '../trackers/TrackerTypes.js';
import { ScoringModelUnavailableError } from './ScoringContracts.js';
import type { ScoringModel } from './ScoringContracts.js';
import {
  buildScoringPrompt, decideByScore, parseScore, repeatReason, SCORE_SCHEMA, SCORE_THRESHOLD,
} from './ScoringRules.js';
import type { ScoreDecision } from './ScoringRules.js';

export type ScoringOptions = Readonly<{
  limit?: number;
  dryRun: boolean;
  threshold?: number;
  /** Overrides the model's default. */
  model?: string;
  /** Send queued jobs to Job-Tracker after scoring; never in a dry run. */
  push: boolean;
  /** Aborting finishes the current job and stops the run. */
  signal?: AbortSignal;
  /** Called after each job, for printing progress. */
  onJob?: (line: ScoringLine) => void;
}>;

type JobRef = Readonly<{ jobId: string; title: string; company: string }>;

export type ScoringLine = JobRef & (
  | Readonly<{ outcome: ScoreDecision; score: number; why: string }>
  | Readonly<{ outcome: 'skipped'; twin: Readonly<{ id: string; title: string; company: string }> }>
  /** The job's status changed while it was being scored (a person acted on it): left alone. */
  | Readonly<{ outcome: 'changed' }>
  /** The model's answer did not parse twice: the job stays `found`, the next run tries again. */
  | Readonly<{ outcome: 'error'; message: string }>
);

/**
 * `end`: all listed jobs handled. `aborted`: the signal stopped the run. `model_unavailable`: the model
 * could not answer at all. `profile`: the Job-Tracker profile could not be had, nothing was scored.
 */
export type ScoringStopReason = 'end' | 'aborted' | 'model_unavailable' | 'profile';

export type ScoringReport = {
  model: string;
  threshold: number;
  dryRun: boolean;
  profile: Readonly<{ revision: number; fromCache: boolean }> | null;
  counts: { queued: number; rejected: number; skipped: number; changed: number; errors: number };
  /** Model calls that gave a score. */
  scored: number;
  /** Model time of scored jobs, and its mean per job in seconds (null when nothing was scored). */
  modelMs: number;
  secondsPerJob: number | null;
  promptTokens: number;
  evalTokens: number;
  stopped: ScoringStopReason;
  /** Why the run stopped early: profile or model failure. */
  error: Readonly<{ code: string; message: string }> | null;
  /** Null when not pushed (dry run, --no-push, aborted or no profile). */
  push: TrackerPushReport | null;
  lines: ScoringLine[];
};

const isStatusChange = (error: unknown) => error instanceof ApplicationError && error.statusCode === 409;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Scores the owner's `found` jobs against their Job-Tracker profile with the local model and decides
 * each one: a repeat of an earlier job is skipped without asking the model; otherwise the score decides
 * between `queued` and `rejected`. Then queued jobs go to Job-Tracker.
 */
export class ScoringService {
  constructor(
    private readonly jobs: JobPipelineApi,
    private readonly tracker: TrackerApi,
    private readonly model: ScoringModel,
  ) {}

  async scoreFound(ownerId: string, options: ScoringOptions): Promise<ScoringReport> {
    const report = emptyReport(options.model ?? this.model.defaultModel, options.threshold ?? SCORE_THRESHOLD, options.dryRun);

    let profile: TrackerProfile;
    try {
      profile = await this.tracker.profile(ownerId);
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      return { ...report, stopped: 'profile', error: { code: error.code, message: error.message } };
    }
    report.profile = { revision: profile.revision, fromCache: profile.fromCache };

    const jobs = await this.jobs.listForScoring(ownerId, options.limit);
    /** Jobs scored in this run, for repeats a dry run cannot find in the database. */
    const scoredInRun = new Map<string, JobRef>();
    for (const job of jobs) {
      if (options.signal?.aborted) { report.stopped = 'aborted'; break; }
      let line: ScoringLine;
      try {
        line = await this.scoreJob(ownerId, job, profile, report, scoredInRun);
      } catch (error) {
        if (error instanceof ScoringModelUnavailableError) {
          report.stopped = 'model_unavailable';
          report.error = { code: 'MODEL_UNAVAILABLE', message: error.message };
          break;
        }
        if (!isStatusChange(error)) throw error;
        line = { ...ref(job), outcome: 'changed' };
      }
      report.lines.push(line);
      report.counts[line.outcome === 'error' ? 'errors' : line.outcome]++;
      options.onJob?.(line);
    }

    report.secondsPerJob = report.scored ? Math.round(report.modelMs / report.scored / 100) / 10 : null;
    if (options.push && !options.dryRun && report.stopped !== 'aborted') {
      report.push = await this.tracker.pushQueued(ownerId, { model: report.model });
    }
    return report;
  }

  /** One job: a repeat is skipped without the model; otherwise the score decides. Writes nothing in a dry run. */
  private async scoreJob(
    ownerId: string, job: PipelineJob, profile: TrackerProfile, report: ScoringReport, scoredInRun: Map<string, JobRef>,
  ): Promise<ScoringLine> {
    const key = twinKey(job.company, job.title);
    const stored = scoredInRun.has(key) ? null : await this.jobs.findTwin(ownerId, job.company, job.title, job.id);
    const twin = scoredInRun.get(key) ?? (stored && ref(stored));
    if (twin) {
      const line: ScoringLine = { ...ref(job), outcome: 'skipped', twin: { id: twin.jobId, title: twin.title, company: twin.company } };
      if (!report.dryRun) await this.jobs.recordDecision(ownerId, job.id, 'skipped', repeatReason(line.twin));
      return line;
    }

    let answer;
    try {
      const prompt = buildScoringPrompt(profile.markdown, job);
      answer = await this.model.chatJson({ ...prompt, schema: SCORE_SCHEMA, model: report.model }, parseScore);
    } catch (error) {
      if (error instanceof ScoringModelUnavailableError) throw error;
      return { ...ref(job), outcome: 'error', message: message(error) };
    }
    report.scored++;
    report.modelMs += answer.durationMs;
    report.promptTokens += answer.promptTokens;
    report.evalTokens += answer.evalTokens;
    scoredInRun.set(key, ref(job));

    const { score, why, redFlags } = answer.value;
    const decision = decideByScore(score, report.threshold);
    if (!report.dryRun) {
      await this.jobs.recordScore(ownerId, job.id, { score, why, redFlags, profileRevision: profile.revision });
      await this.jobs.recordDecision(ownerId, job.id, decision);
    }
    return { ...ref(job), outcome: decision, score, why };
  }
}

function ref(job: PipelineJob): JobRef {
  return { jobId: job.id, title: job.title, company: job.company };
}

function emptyReport(model: string, threshold: number, dryRun: boolean): ScoringReport {
  return {
    model, threshold, dryRun, profile: null,
    counts: { queued: 0, rejected: 0, skipped: 0, changed: 0, errors: 0 },
    scored: 0, modelMs: 0, secondsPerJob: null, promptTokens: 0, evalTokens: 0,
    stopped: 'end', error: null, push: null, lines: [],
  };
}
