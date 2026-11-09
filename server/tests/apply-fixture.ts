import type { PrismaClient } from '../generated/prisma/client.js';
import { acquireBrowserLock } from '../plugins/browser-lock.js';
import { createApplicationService } from '../framework/composition/create-applications.js';
import { AnswerRepository } from '../src/answers/AnswerRepository.js';
import { AnswerService } from '../src/answers/AnswerService.js';
import { ApplyAgentError } from '../src/applications/ApplicationContracts.js';
import type { ApplyAgent, ApplyAgentRequest, ApplyAgentResult, ApplySettings } from '../src/applications/ApplicationContracts.js';
import { JobRepository } from '../src/jobs/JobRepository.js';
import { JobService } from '../src/jobs/JobService.js';
import { TrackerError } from '../src/trackers/TrackerTypes.js';
import type {
  JobTrackerClient, TrackerApplicationInput, TrackerMarkResult, TrackerProfileContext, TrackerToApplyJob, TrackerToApplyPage,
} from '../src/trackers/TrackerTypes.js';

/** Fakes for applying: an in-memory Job-Tracker, a scripted agent and a service on the test database. */

export const linkedinUrl = (id: number) => `https://www.linkedin.com/jobs/view/${id}/`;

/** JT with a To Apply list; `markMode` decides the answer of POST …/application. */
export class FakeApplyTracker implements JobTrackerClient {
  email = 'owner@example.test';
  toApply: TrackerToApplyJob[] = [];
  marks: { jobId: string; input: TrackerApplicationInput }[] = [];
  markMode: 'created' | 'already_applied' | 'not_found' | 'conflict' | 'down' = 'created';

  async whoami() { return { user: { id: 'jt-user', email: this.email, name: null } }; }
  async profileContext(): Promise<TrackerProfileContext> {
    return { status: 'modified', markdown: '# Candidate\nLocation: Dublin <Ireland>\nSalary: min 40000, target 48000 EUR', revision: 1, etag: null };
  }
  async pushJobs() { return []; }
  async listJobs() { return { ids: [], nextCursor: null }; }
  async recordEvaluation() {}
  async listToApply(cursor?: string | null): Promise<TrackerToApplyPage> {
    // Pages of two, to see that the service reads them all.
    const start = cursor ? Number(cursor) : 0;
    const items = this.toApply.slice(start, start + 2);
    return { items, nextCursor: start + 2 < this.toApply.length ? String(start + 2) : null };
  }
  async markApplied(jobId: string, input: TrackerApplicationInput): Promise<TrackerMarkResult> {
    this.marks.push({ jobId, input });
    switch (this.markMode) {
      case 'created': return { status: 'created', applicationId: jobId };
      case 'already_applied': return { status: 'already_applied', applicationId: jobId };
      case 'not_found': return { status: 'not_found' };
      case 'conflict': return { status: 'conflict', message: 'Job-Tracker отклонил запрос (HTTP 409)' };
      case 'down': throw new TrackerError('unavailable', 'Job-Tracker недоступен.');
    }
  }
}

export type AgentStep = (request: ApplyAgentRequest) => unknown;

/** Each run takes the next scripted answer: the structured output, or an Error to throw. */
export class FakeAgent implements ApplyAgent {
  requests: ApplyAgentRequest[] = [];
  steps: AgentStep[] = [];
  costMicros = 20_000;
  /** What the guard saw in each run; a click that was let through makes a failed submit "maybe sent". */
  toolCalls: ApplyAgentResult['toolCalls'] = [{ tool: 'mcp__playwright__browser_snapshot', decision: 'allow' }];
  /** Screenshot files each run reports. */
  screenshots: string[] = [];

  async run(request: ApplyAgentRequest): Promise<ApplyAgentResult> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error('FakeAgent: no scripted answer left');
    const output = step(request);
    if (output instanceof Error) throw output;
    return {
      output, sessionId: `session-${this.requests.length}`, turns: 10, durationMs: 1000,
      tokens: { input: 1000, cacheRead: 5000, output: 300 }, costMicros: this.costMicros, runDir: null,
      toolCalls: this.toolCalls, screenshots: this.screenshots,
    };
  }
}

export const agentAnswer = (outcome: string, extra: Record<string, unknown> = {}) => () => ({
  outcome, summary: '', filled: [], questions: [], ...extra,
});
export const agentFailure = (message: string, aborted = false) => () =>
  new ApplyAgentError(message, { tokens: { input: 10, cacheRead: 0, output: 1 }, costMicros: 500 }, { aborted });

export const testApplySettings: ApplySettings = { cvPath: '/srv/agent-files/agent-run/files/cv.pdf', maxPerRun: 5, maxMicrosPerDay: 500_000, autoSubmit: false };

export function createTestApplier(prisma: PrismaClient, options: Readonly<{
  tracker: JobTrackerClient | null; agent: ApplyAgent; lockPath: string; settings?: ApplySettings; now?: () => Date;
}>) {
  const jobs = new JobService(new JobRepository(prisma));
  const answers = new AnswerService(new AnswerRepository(prisma));
  const applications = createApplicationService(prisma, {
    jobs, answers,
    users: { profile: async (id) => prisma.user.findUnique({ where: { id } }).then((user) => user && { ...user, createdAt: user.createdAt.toISOString() }) as never },
    tracker: options.tracker, agent: options.agent,
    browser: { acquire: (task) => acquireBrowserLock({ task, path: options.lockPath }) },
    settings: options.settings ?? testApplySettings,
    clock: { now: options.now ?? (() => new Date()) },
  });
  return { applications, jobs, answers };
}
