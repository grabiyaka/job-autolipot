import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { Clock } from '../../framework/core/runtime.js';
import type { AnswerApi } from '../answers/AnswerTypes.js';
import type { JobPipelineApi, PipelineJob } from '../jobs/JobTypes.js';
import { TrackerError } from '../trackers/TrackerTypes.js';
import type { TrackerApi, TrackerApplyApi, TrackerProfile } from '../trackers/TrackerTypes.js';
import { ApplyAgentError } from './ApplicationContracts.js';
import type { ApplyAgent, ApplyAgentResult, ApplyBrowser, ApplySettings } from './ApplicationContracts.js';
import type { ApplicationRepository } from './ApplicationRepository.js';
import {
  appliedByHandNote, applyStartUrl, attemptKind, budgetDayStart, buildApplyPrompt, buildSubmitFreshPrompt, buildSubmitPrompt,
  decideByOutcome, fillOutcomes, fillSchema, httpsPageUrl, maybeSubmitted, notHttpsNote, parseAgentAnswer, questionTexts, rejectedByHandNote,
  requireHttpsForm, submitFreshOutcomes, webPageUrl,
  submitFreshSchema, submitOutcomes, submitSchema, trackerChannel, trackerChannels, trackerNote, usd, withinBudget,
} from './ApplicationRules.js';
import type { AgentAnswer, SubmitFreshOutcome } from './ApplicationRules.js';
import type {
  AnswerReport, ApplicationApi, ApplicationDetails, ApplicationStatus, ApplicationView, FillLine, FillOptions, FillReport, FillStop,
  PendingView, QuestionView, SubmitReport, TrackerMarkOutcome, TrackerResend,
} from './ApplicationTypes.js';

export { applicationKinds, applicationStatuses, questionStatuses } from './ApplicationTypes.js';
export type {
  ApplicationDetails, ApplicationKind, ApplicationStatus, ApplicationView, FilledField, FillReport, QuestionView, SubmitReport,
} from './ApplicationTypes.js';

/** An attempt with what only this domain needs: the agent session, the job's Job-Tracker link and the mark's channel. */
export type StoredApplication = ApplicationView & Readonly<{
  sessionId: string | null; trackerId: string | null; jobStatus: string; trackerChannel: string | null;
}>;

type Spend = Readonly<{ tokens: { input: number; cacheRead: number; output: number }; costMicros: number }>;
const noSpend: Spend = { tokens: { input: 0, cacheRead: 0, output: 0 }, costMicros: 0 };

export type AnswerInput = Readonly<{ answer: string }>;

/** Jobs a To Apply run takes: not yet tried, or put back to the queue. */
const fillableStatuses: readonly string[] = ['found', 'scored', 'rejected', 'queued'];
/** A job named with --job may also be retried after a failure, a skip, open questions or a `manual`. */
const retryableStatuses: readonly string[] = [...fillableStatuses, 'failed', 'skipped', 'needs_input', 'applying', 'manual'];
/** ❌ is allowed from these attempt statuses. */
const rejectableStatuses: readonly ApplicationStatus[] = ['ready', 'needs_input', 'manual'];
const interruptedNote = 'прерван: прошлый запуск не закончился';

function view(application: StoredApplication): ApplicationView {
  const { sessionId: _session, trackerId: _tracker, jobStatus: _status, trackerChannel: _channel, ...rest } = application;
  return rest;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Applying through the browser agent. One job at a time (one browser), the agent stops before Submit,
 * and the attempt waits for the owner's ✅. Every query is scoped to the owner.
 */
export class ApplicationService implements ApplicationApi {
  constructor(
    private readonly applications: ApplicationRepository,
    private readonly jobs: Pick<JobPipelineApi, 'findById' | 'findByTrackerId' | 'findByUrl' | 'importQueued' | 'markSynced' | 'recordApplyStatus'>,
    private readonly tracker: TrackerApplyApi & Pick<TrackerApi, 'profile'>,
    private readonly answers: AnswerApi,
    private readonly agent: ApplyAgent | null,
    private readonly browser: ApplyBrowser,
    private readonly clock: Clock,
    private readonly settings: ApplySettings,
  ) {}

  // ── Owner's actions over HTTP ──

  async list(actor: Actor): Promise<ApplicationView[]> {
    return (await this.applications.list(actor.id)).map(view);
  }

  async get(actor: Actor, id: string): Promise<ApplicationDetails> {
    const application = await this.owned(actor.id, id);
    return { ...view(application), questions: await this.applications.questionsOf(actor.id, id) };
  }

  submitAs(actor: Actor, id: string): Promise<SubmitReport> {
    return this.submit(actor.id, id);
  }

  markManualAppliedAs(actor: Actor, id: string): Promise<SubmitReport> {
    return this.markManualApplied(actor.id, id);
  }

  answerAs(actor: Actor, questionId: string, input: AnswerInput): Promise<AnswerReport> {
    return this.answerQuestion(actor.id, questionId, input.answer, 'manual');
  }

  // ── Fill ──

  async fillNext(ownerId: string, options: FillOptions = {}): Promise<FillReport> {
    const limit = options.limit ?? this.settings.maxPerRun;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ApplicationError('INVALID_QUERY', 'limit — целое число от 1.', 400);
    const agent = this.requireAgent();
    const cvPath = this.settings.cvPath;
    if (!cvPath) throw new ApplicationError('APPLY_CV_MISSING', 'Не задано резюме для загрузки: APPLY_CV_FILE в .env (файл из /srv/agent-files).', 503);
    if (!this.tracker.configured) {
      throw new ApplicationError('TRACKER_NOT_CONFIGURED', 'Job-Tracker не настроен: задайте JOB_TRACKER_URL и JOB_TRACKER_TOKEN — профиль и To Apply берутся оттуда.', 503);
    }

    const resent = await this.resendTrackerMarks(ownerId);
    const lock = this.browser.acquire('apply');
    const lines: FillLine[] = [];
    const ready: ApplicationView[] = [];
    const manual: ApplicationView[] = [];
    const questions: QuestionView[] = [];
    let stopped: FillStop = 'end';
    let runs = 0;
    let profile: TrackerProfile | null = null;
    try {
      const candidates = options.jobId ? [await this.namedJob(ownerId, options.jobId)] : await this.toApplyJobs(ownerId);
      for (const job of candidates) {
        if (options.signal?.aborted) { stopped = 'aborted'; break; }
        // LinkedIn and external job pages both go to the agent; it takes https only, the rest is the owner's.
        if (!applyStartUrl(job.url)) {
          const attempt = await this.manualWithoutAgent(ownerId, job);
          lines.push({ jobId: job.id, title: job.title, company: job.company, applicationId: attempt.id, status: 'manual', note: notHttpsNote, costMicros: 0 });
          manual.push(attempt);
          continue;
        }
        if (runs >= limit) { stopped = 'limit'; break; }
        if (!withinBudget(await this.spentToday(ownerId), this.settings.maxMicrosPerDay)) { stopped = 'budget'; break; }
        profile ??= await this.tracker.profile(ownerId);
        runs++;
        const attempt = await this.fillOne(ownerId, agent, job, profile.markdown, cvPath, options.signal);
        lines.push(attempt.line);
        if (attempt.ready) ready.push(attempt.ready);
        if (attempt.manual) manual.push(attempt.manual);
        questions.push(...attempt.questions);
        if (attempt.aborted) { stopped = 'aborted'; break; }
      }
    } finally {
      lock.release();
    }
    return { lines, stopped, spentTodayMicros: await this.spentToday(ownerId), budgetMicros: this.settings.maxMicrosPerDay, resent, ready, questions, manual };
  }

  /** A job page the agent cannot open (not https): a `manual` attempt with the link, no agent run. */
  private async manualWithoutAgent(ownerId: string, job: PipelineJob): Promise<ApplicationView> {
    await this.toApplying(ownerId, job);
    const attempt = await this.applications.create(ownerId, job.id, this.clock.now());
    await this.applications.finish(ownerId, attempt.id, ['running'], {
      status: 'manual', note: notHttpsNote, finishedAt: this.clock.now(), ...noSpend, kind: 'external', applyUrl: webPageUrl(job.url),
    });
    await this.jobs.recordApplyStatus(ownerId, job.id, 'manual', notHttpsNote);
    return view(await this.owned(ownerId, attempt.id));
  }

  /** One agent run for one job, recorded as an attempt. */
  private async fillOne(
    ownerId: string, agent: ApplyAgent, job: PipelineJob, profileMarkdown: string, cvPath: string, signal: AbortSignal | undefined,
  ): Promise<{ line: FillLine; ready: ApplicationView | null; manual: ApplicationView | null; questions: QuestionView[]; aborted: boolean }> {
    await this.applications.markQuestionsUsed(ownerId, job.id);
    await this.toApplying(ownerId, job);
    const attempt = await this.applications.create(ownerId, job.id, this.clock.now());
    const line = (status: ApplicationStatus, note: string, costMicros: number): FillLine => ({
      jobId: job.id, title: job.title, company: job.company, applicationId: attempt.id, status, note, costMicros,
    });

    const startUrl = applyStartUrl(job.url)!;
    const { systemPrompt, prompt } = buildApplyPrompt(profileMarkdown, await this.answers.listForUser(ownerId), job, cvPath);
    let result: ApplyAgentResult;
    try {
      result = await agent.run({ prompt, systemPrompt, schema: fillSchema, mode: 'fill', startUrl, ...(signal ? { signal } : {}) });
    } catch (error) {
      const failure = error instanceof ApplyAgentError ? error : null;
      const aborted = Boolean(failure?.details.aborted || signal?.aborted);
      // A stop or a missing agent is not the job's fault: it goes back to the queue.
      const requeue = aborted || Boolean(failure?.details.unavailable) || !failure;
      const note = aborted ? 'остановлено' : `ошибка агента: ${message(error)}`;
      await this.applications.finish(ownerId, attempt.id, ['running'], {
        status: 'failed', note, finishedAt: this.clock.now(),
        tokens: failure?.spend.tokens ?? { input: 0, cacheRead: 0, output: 0 }, costMicros: failure?.spend.costMicros ?? 0,
        sessionId: failure?.details.sessionId ?? null,
        result: JSON.stringify({ error: message(error), runDir: failure?.details.runDir ?? null, toolCalls: failure?.details.toolCalls ?? [] }),
      });
      await this.jobs.recordApplyStatus(ownerId, job.id, requeue ? 'queued' : 'failed', requeue ? undefined : note);
      if (failure?.details.unavailable) throw new ApplicationError('AGENT_UNAVAILABLE', failure.message, 503);
      if (!failure && !aborted) throw error;
      return { line: line('failed', note, failure?.spend.costMicros ?? 0), ready: null, manual: null, questions: [], aborted };
    }

    const answer = parseAgentAnswer(result.output, fillOutcomes);
    // The form's page: where ✅ starts for an external form and the link for `manual`; the job page when the agent gave none.
    const kind = attemptKind(answer?.kind ?? null, job.url);
    const applyUrl = answer?.applyUrl ?? startUrl;
    const decision = answer
      ? requireHttpsForm(decideByOutcome(answer.outcome, answer.summary), kind, applyUrl)
      : { application: 'failed' as const, job: 'failed' as const, note: 'ответ агента не по схеме' };
    await this.applications.finish(ownerId, attempt.id, ['running'], {
      status: decision.application, note: decision.note, finishedAt: this.clock.now(), sessionId: result.sessionId,
      tokens: result.tokens, costMicros: result.costMicros, kind, applyUrl,
      result: JSON.stringify({ answer: answer ?? result.output, turns: result.turns, durationMs: result.durationMs, runDir: result.runDir, toolCalls: result.toolCalls }),
    });
    if (decision.job) await this.jobs.recordApplyStatus(ownerId, job.id, decision.job, decision.note);
    const questions = answer && decision.application === 'needs_input'
      ? await this.applications.createQuestions(attempt.id, questionTexts(answer), this.clock.now())
      : [];
    const saved = await this.owned(ownerId, attempt.id);
    return {
      line: line(decision.application, decision.note, result.costMicros),
      ready: decision.application === 'ready' ? view(saved) : null,
      manual: decision.application === 'manual' ? view(saved) : null,
      questions,
      aborted: false,
    };
  }

  /** JT's To Apply rows as local jobs, oldest first: linked by Job-Tracker id or URL, imported as queued otherwise. */
  private async toApplyJobs(ownerId: string): Promise<PipelineJob[]> {
    const jobs: PipelineJob[] = [];
    for (const row of await this.tracker.listToApply(ownerId)) {
      let job = await this.jobs.findByTrackerId(ownerId, row.id) ?? (row.url ? await this.jobs.findByUrl(ownerId, row.url) : null);
      if (job && job.trackerId === null) {
        job = await this.jobs.markSynced(ownerId, job.id, row.id).catch(() => job);
      }
      if (!job && row.url) {
        const input = { url: row.url, source: row.source || 'job-tracker', title: row.title || 'без названия', company: row.company || 'без компании' };
        job = await this.jobs.importQueued(ownerId, input, row.id).catch(() => null) ?? await this.jobs.findByUrl(ownerId, row.url);
      }
      if (job && fillableStatuses.includes(job.status)) jobs.push(job);
    }
    return jobs;
  }

  /** `--job`: an id here or in Job-Tracker; retried even after a failure or a skip, never after applied or while waiting for ✅. */
  private async namedJob(ownerId: string, id: string): Promise<PipelineJob> {
    const job = await this.jobs.findById(ownerId, id) ?? await this.jobs.findByTrackerId(ownerId, id);
    if (!job) throw new ApplicationError('JOB_NOT_FOUND', 'Вакансия не найдена.', 404);
    if (!retryableStatuses.includes(job.status)) throw new ApplicationError('JOB_NOT_FILLABLE', `Вакансия в статусе «${job.status}»: подача уже не нужна.`, 409);
    if (job.status === 'applying' && (await this.applications.list(ownerId, ['ready'])).some((item) => item.jobId === job.id)) {
      throw new ApplicationError('APPLICATION_WAITING', 'Вакансия уже заполнена и ждёт ✅: --list, --submit или отказ.', 409);
    }
    return job;
  }

  /** Any fillable status → queued → applying; a stale `applying` (a run that died) first closes its attempt. */
  private async toApplying(ownerId: string, job: PipelineJob): Promise<void> {
    if (job.status === 'applying') {
      await this.applications.failRunning(ownerId, job.id, interruptedNote, this.clock.now());
      await this.jobs.recordApplyStatus(ownerId, job.id, 'queued');
    } else if (job.status !== 'queued') {
      await this.jobs.recordApplyStatus(ownerId, job.id, 'queued');
    }
    await this.jobs.recordApplyStatus(ownerId, job.id, 'applying');
  }

  // ── Submit ──

  async submit(ownerId: string, applicationId: string, signal?: AbortSignal): Promise<SubmitReport> {
    const attempt = await this.owned(ownerId, applicationId);
    if (attempt.status !== 'ready') {
      throw new ApplicationError('APPLICATION_NOT_READY', `Отправить можно только заполненную попытку (ready), а эта — «${attempt.status}».`, 409);
    }
    if (attempt.kind === 'external') return this.submitFresh(ownerId, attempt, signal);
    if (!attempt.sessionId) throw new ApplicationError('APPLICATION_NOT_READY', 'У попытки нет сессии агента: заполните вакансию заново.', 409);
    const agent = this.requireAgent();
    // The resumed session gets the same rules as the fill run: --system-prompt-file replaces the prompt.
    const job = await this.jobs.findById(ownerId, attempt.jobId);
    if (!job) throw new ApplicationError('JOB_NOT_FOUND', 'Вакансия не найдена.', 404);
    const profile = await this.tracker.profile(ownerId);
    const { systemPrompt } = buildApplyPrompt(profile.markdown, await this.answers.listForUser(ownerId), job, this.settings.cvPath ?? '(already uploaded)', 'submit');
    const startUrl = applyStartUrl(job.url) ?? undefined;
    const lock = this.browser.acquire('apply:submit');
    let result: ApplyAgentResult;
    try {
      result = await agent.run({
        prompt: buildSubmitPrompt(attempt.url), systemPrompt, schema: submitSchema, mode: 'submit', resumeSessionId: attempt.sessionId,
        ...(startUrl ? { startUrl } : {}), ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const failure = error instanceof ApplyAgentError ? error : null;
      return this.submitFailed(ownerId, attempt, `ошибка агента: ${message(error)}`, failure?.details.toolCalls ?? [], failure?.spend ?? noSpend);
    } finally {
      lock.release();
    }

    const answer = parseAgentAnswer(result.output, submitOutcomes);
    if (answer?.outcome !== 'submitted') {
      const note = answer ? `не отправлено (${answer.outcome}): ${answer.summary}` : 'ответ агента не по схеме';
      return this.submitFailed(ownerId, attempt, note, result.toolCalls, result);
    }
    return this.submitted(ownerId, attempt, answer.summary, result);
  }

  /**
   * ✅ on an external form. The fill's tab is gone, so it is not --resume: a new run opens `applyUrl`,
   * fills the form again with the same profile, answers and posting, checks it against the previous fill
   * and sends it once. It costs about as much as the fill and counts against the daily budget.
   */
  private async submitFresh(ownerId: string, attempt: StoredApplication, signal: AbortSignal | undefined): Promise<SubmitReport> {
    const applyUrl = httpsPageUrl(attempt.applyUrl);
    if (!applyUrl) {
      // The agent takes https only: the owner applies by hand.
      const note = `${notHttpsNote} (${attempt.applyUrl ?? 'нет адреса формы'})`;
      await this.applications.finish(ownerId, attempt.id, ['ready'], { status: 'manual', note, finishedAt: this.clock.now(), ...noSpend });
      await this.jobs.recordApplyStatus(ownerId, attempt.jobId, 'manual', note);
      return { application: view(await this.owned(ownerId, attempt.id)), tracker: null, message: `не отправлено: ${note}` };
    }
    const agent = this.requireAgent();
    const cvPath = this.settings.cvPath;
    if (!cvPath) throw new ApplicationError('APPLY_CV_MISSING', 'Не задано резюме для загрузки: APPLY_CV_FILE в .env (файл из /srv/agent-files).', 503);
    const job = await this.jobs.findById(ownerId, attempt.jobId);
    if (!job) throw new ApplicationError('JOB_NOT_FOUND', 'Вакансия не найдена.', 404);
    const spent = await this.spentToday(ownerId);
    if (!withinBudget(spent, this.settings.maxMicrosPerDay)) {
      throw new ApplicationError('APPLY_BUDGET_SPENT', `Дневной лимит затрат исчерпан (${usd(spent)} из ${usd(this.settings.maxMicrosPerDay)}): отправка заполнит форму заново, повторите завтра.`, 409);
    }
    const profile = await this.tracker.profile(ownerId);
    const { systemPrompt, prompt } = buildSubmitFreshPrompt(profile.markdown, await this.answers.listForUser(ownerId), job, cvPath, applyUrl, attempt.filled);
    const lock = this.browser.acquire('apply:submit');
    let result: ApplyAgentResult;
    try {
      result = await agent.run({
        prompt, systemPrompt, schema: submitFreshSchema, mode: 'submit_fresh', startUrl: applyUrl, ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const failure = error instanceof ApplyAgentError ? error : null;
      return this.submitFailed(ownerId, attempt, `ошибка агента: ${message(error)}`, failure?.details.toolCalls ?? [], failure?.spend ?? noSpend);
    } finally {
      lock.release();
    }

    const answer = parseAgentAnswer(result.output, submitFreshOutcomes);
    if (!answer) return this.submitFailed(ownerId, attempt, 'ответ агента не по схеме', result.toolCalls, result);
    if (answer.outcome === 'submitted') return this.submitted(ownerId, attempt, answer.summary, result);
    if (answer.outcome === 'blocked' || answer.outcome === 'failed') {
      return this.submitFailed(ownerId, attempt, `не отправлено (${answer.outcome}): ${answer.summary}`, result.toolCalls, result);
    }
    return this.submitStopped(ownerId, attempt, answer, result);
  }

  /** submit_fresh stopped without sending on purpose: new questions (needs_input), an account or captcha (manual), closed, a filter. */
  private async submitStopped(
    ownerId: string, attempt: StoredApplication, answer: AgentAnswer<SubmitFreshOutcome>, spend: Spend,
  ): Promise<SubmitReport> {
    const decision = decideByOutcome(answer.outcome, answer.summary);
    await this.applications.finish(ownerId, attempt.id, ['ready'], {
      status: decision.application, note: decision.note, finishedAt: this.clock.now(), tokens: spend.tokens, costMicros: spend.costMicros,
      ...(answer.applyUrl ? { applyUrl: answer.applyUrl } : {}),
    });
    if (decision.job) await this.jobs.recordApplyStatus(ownerId, attempt.jobId, decision.job, decision.note);
    if (decision.application === 'needs_input') await this.applications.createQuestions(attempt.id, questionTexts(answer), this.clock.now());
    return { application: view(await this.owned(ownerId, attempt.id)), tracker: null, message: `не отправлено: ${decision.note}` };
  }

  /** The agent confirmed the send: the attempt is submitted, the job applied, and Job-Tracker is marked. */
  private async submitted(ownerId: string, attempt: StoredApplication, summary: string, spend: Spend): Promise<SubmitReport> {
    const submittedAt = this.clock.now();
    const channel = trackerChannel(attempt.kind);
    await this.applications.finish(ownerId, attempt.id, ['ready'], {
      status: 'submitted', note: summary ? `отправлено: ${summary}` : 'отправлено', finishedAt: submittedAt,
      tokens: spend.tokens, costMicros: spend.costMicros, trackerChannel: channel,
    });
    await this.jobs.recordApplyStatus(ownerId, attempt.jobId, 'applied');
    const marked = await this.markTracker(ownerId, { ...attempt, status: 'submitted', trackerChannel: channel }, submittedAt);
    return { application: view(await this.owned(ownerId, attempt.id)), tracker: marked?.outcome ?? null, message: marked?.message ?? 'Отправлено; в Job-Tracker вакансия не связана.' };
  }

  /**
   * «✅ подал сам»: the owner applied by hand on a site the agent could not use (an account, a captcha,
   * Workday…). Only from `manual`; the job becomes applied and JT gets `channel: company_site_manual`.
   */
  async markManualApplied(ownerId: string, applicationId: string): Promise<SubmitReport> {
    const attempt = await this.owned(ownerId, applicationId);
    if (attempt.status !== 'manual') {
      throw new ApplicationError('APPLICATION_NOT_MANUAL', `«Подал сам» отмечается только для попытки manual, а эта — «${attempt.status}».`, 409);
    }
    const job = await this.jobs.findById(ownerId, attempt.jobId);
    if (!job) throw new ApplicationError('JOB_NOT_FOUND', 'Вакансия не найдена.', 404);
    if (job.status !== 'manual' && job.status !== 'applied') {
      throw new ApplicationError('JOB_NOT_MANUAL', `Вакансия уже в статусе «${job.status}» (её заполняют заново?): отметка не нужна.`, 409);
    }
    const appliedAt = this.clock.now();
    const channel = trackerChannels.manual;
    if (!await this.applications.finish(ownerId, attempt.id, ['manual'], {
      status: 'submitted', note: appliedByHandNote, finishedAt: appliedAt, ...noSpend, trackerChannel: channel,
    })) {
      throw new ApplicationError('APPLICATION_NOT_MANUAL', 'Попытка уже изменилась: обновите список.', 409);
    }
    if (job.status === 'manual') await this.jobs.recordApplyStatus(ownerId, job.id, 'applied', appliedByHandNote);
    const marked = await this.markTracker(ownerId, { ...attempt, status: 'submitted', trackerChannel: channel }, appliedAt);
    return {
      application: view(await this.owned(ownerId, attempt.id)), tracker: marked?.outcome ?? null,
      message: marked?.message ?? 'Отмечено: подано вручную; в Job-Tracker вакансия не связана.',
    };
  }

  /**
   * The form was not confirmed as sent. If the guard let a click through, it may have been sent:
   * the job is `failed` for the owner to check on LinkedIn. Otherwise it is queued and filled again.
   */
  private async submitFailed(
    ownerId: string, attempt: StoredApplication, reason: string, toolCalls: readonly { tool: string; decision: string }[], spend: Spend,
  ): Promise<SubmitReport> {
    // submit_fresh clicks while it fills, so any allowed click there also means "maybe sent".
    const unsure = maybeSubmitted(toolCalls);
    const where = attempt.kind === 'external' ? `на сайте: ${attempt.applyUrl ?? attempt.url}` : 'в LinkedIn';
    const note = unsure ? `отправка не подтверждена — проверьте ${where}; ${reason}` : `не отправлено, будет заполнено заново; ${reason}`;
    await this.applications.finish(ownerId, attempt.id, ['ready'], { status: 'failed', note, finishedAt: this.clock.now(), tokens: spend.tokens, costMicros: spend.costMicros });
    await this.jobs.recordApplyStatus(ownerId, attempt.jobId, unsure ? 'failed' : 'queued', unsure ? note : undefined);
    return { application: view(await this.owned(ownerId, attempt.id)), tracker: null, message: note };
  }

  /**
   * Marks a submitted attempt in Job-Tracker. created / already_applied / 404 (no longer in To Apply)
   * finish it as `applied`; 409 and outages keep it `submitted`, and the next fill run sends it again.
   */
  private async markTracker(ownerId: string, attempt: StoredApplication, appliedAt: Date): Promise<{ outcome: TrackerMarkOutcome; message: string } | null> {
    const finish = async (outcome: TrackerMarkOutcome, status: ApplicationStatus, note: string) => {
      await this.applications.setStatus(ownerId, attempt.id, ['submitted'], status, note, appliedAt);
      return { outcome, message: note };
    };
    if (!attempt.trackerId) {
      await this.applications.setStatus(ownerId, attempt.id, ['submitted'], 'applied', 'отправлено; вакансии нет в Job-Tracker', appliedAt);
      return null;
    }
    if (!this.tracker.configured) return { outcome: 'unavailable', message: 'Job-Tracker не настроен: отметка будет отправлена позже.' };
    try {
      const channel = attempt.trackerChannel ?? trackerChannel(attempt.kind);
      const result = await this.tracker.markApplied(ownerId, attempt.trackerId, { appliedAt, note: trackerNote(channel), channel });
      switch (result.status) {
        case 'created': return finish('marked', 'applied', 'отправлено и отмечено в Job-Tracker');
        case 'already_applied': return finish('already_applied', 'applied', 'отправлено; в Job-Tracker уже было отмечено');
        case 'not_found': return finish('not_in_to_apply', 'applied', 'отправлено; в Job-Tracker вакансии уже нет в To Apply (переведена вручную?)');
        case 'conflict': return finish('conflict', 'submitted', `отправлено, но Job-Tracker не принял отметку (409: неоднозначная компания или дубль) — разберите в Job-Tracker; ${result.message}`);
      }
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'TRACKER_NOT_LINKED') {
        return finish('not_linked', 'submitted', 'отправлено; Job-Tracker не привязан к этому пользователю');
      }
      if (!(error instanceof TrackerError)) throw error;
      return finish('unavailable', 'submitted', `отправлено; Job-Tracker не ответил, отметка уйдёт следующим запуском (${error.message})`);
    }
  }

  private async resendTrackerMarks(ownerId: string): Promise<TrackerResend[]> {
    if (!this.tracker.configured) return [];
    const resent: TrackerResend[] = [];
    for (const attempt of await this.applications.list(ownerId, ['submitted'])) {
      if (!attempt.trackerId) continue;
      const marked = await this.markTracker(ownerId, attempt, new Date(attempt.finishedAt ?? attempt.startedAt));
      if (marked) resent.push({ applicationId: attempt.id, title: attempt.jobTitle, result: marked.message, ok: !['conflict', 'unavailable', 'not_linked'].includes(marked.outcome) });
    }
    return resent;
  }

  // ── ❌ and questions ──

  async reject(ownerId: string, applicationId: string): Promise<ApplicationView> {
    const attempt = await this.owned(ownerId, applicationId);
    if (!rejectableStatuses.includes(attempt.status)) {
      throw new ApplicationError('APPLICATION_NOT_READY', `Отказаться можно от заполненной попытки, попытки с вопросами или ручной подачи, а эта — «${attempt.status}».`, 409);
    }
    await this.applications.setStatus(ownerId, attempt.id, rejectableStatuses, 'skipped', rejectedByHandNote, this.clock.now());
    await this.applications.closeOpenQuestions(ownerId, attempt.id);
    const job = await this.jobs.findById(ownerId, attempt.jobId);
    if (job && ['applying', 'needs_input', 'manual'].includes(job.status)) await this.jobs.recordApplyStatus(ownerId, job.id, 'skipped', rejectedByHandNote);
    return view(await this.owned(ownerId, attempt.id));
  }

  async answerQuestion(ownerId: string, questionId: string, answer: string, origin: 'manual' | 'telegram'): Promise<AnswerReport> {
    const question = await this.applications.findQuestion(ownerId, questionId);
    if (!question) throw new ApplicationError('QUESTION_NOT_FOUND', 'Вопрос не найден.', 404);
    if (question.status !== 'open') throw new ApplicationError('QUESTION_ANSWERED', 'На этот вопрос уже ответили.', 409);
    const saved = await this.answers.upsert(ownerId, question.text, answer, origin);
    if (!await this.applications.answerQuestion(ownerId, questionId, saved.answer, this.clock.now())) {
      throw new ApplicationError('QUESTION_ANSWERED', 'На этот вопрос уже ответили.', 409);
    }
    const remaining = (await this.applications.openQuestions(ownerId, question.applicationId)).length;
    let requeued = false;
    if (remaining === 0) {
      // The LinkedIn form closes within hours, so the next fill starts the form again with the new answers.
      const job = await this.jobs.findById(ownerId, question.jobId);
      if (job?.status === 'needs_input') {
        await this.jobs.recordApplyStatus(ownerId, job.id, 'queued');
        requeued = true;
      }
    }
    return { question: (await this.applications.findQuestion(ownerId, questionId))!, remaining, requeued };
  }

  async pending(ownerId: string): Promise<PendingView> {
    return {
      ready: (await this.applications.list(ownerId, ['ready'])).map(view),
      questions: await this.applications.openQuestions(ownerId),
      // An old `manual` attempt of a job that was filled again (--job) is not the owner's task any more.
      manual: (await this.applications.list(ownerId, ['manual'])).filter((item) => item.jobStatus === 'manual').map(view),
    };
  }

  async setQuestionMessage(ownerId: string, questionId: string, messageId: string): Promise<void> {
    if (!await this.applications.setQuestionMessage(ownerId, questionId, messageId)) {
      throw new ApplicationError('QUESTION_NOT_FOUND', 'Вопрос не найден.', 404);
    }
  }

  async findQuestionByMessage(ownerId: string, messageId: string): Promise<QuestionView | null> {
    return this.applications.findQuestionByMessage(ownerId, messageId);
  }

  // ── Helpers ──

  private spentToday(ownerId: string): Promise<number> {
    return this.applications.spentSince(ownerId, budgetDayStart(this.clock.now()));
  }

  private requireAgent(): ApplyAgent {
    if (!this.agent) throw new ApplicationError('AGENT_NOT_CONFIGURED', 'Агент подачи не настроен на этом процессе: используйте npm run apply или бота.', 503);
    return this.agent;
  }

  private async owned(ownerId: string, id: string): Promise<StoredApplication> {
    const application = await this.applications.find(ownerId, id);
    if (!application) throw new ApplicationError('APPLICATION_NOT_FOUND', 'Попытка подачи не найдена.', 404);
    return application;
  }
}
