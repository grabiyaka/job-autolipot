import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import type { ApplicationKind, ApplicationStatus, FilledField, QuestionView, StoredApplication } from './ApplicationService.js';

const withJob = { job: { select: { title: true, company: true, url: true, trackerId: true, status: true, userId: true } } } as const;
type ApplicationRecord = Prisma.ApplicationGetPayload<{ include: typeof withJob }>;
const questionWithJob = { application: { select: { jobId: true, applyUrl: true, job: { select: { title: true, company: true, url: true } } } } } as const;
type QuestionRecord = Prisma.QuestionGetPayload<{ include: typeof questionWithJob }>;

/** `result` keeps the agent's answer as JSON; only `filled` and `summary` are read back. */
function storedResult(raw: string | null): { filled: FilledField[]; summary: string | null } {
  if (!raw) return { filled: [], summary: null };
  try {
    const data = JSON.parse(raw) as { answer?: { filled?: FilledField[]; summary?: string } };
    return { filled: Array.isArray(data.answer?.filled) ? data.answer.filled : [], summary: data.answer?.summary || null };
  } catch {
    return { filled: [], summary: null };
  }
}

function toApplication(record: ApplicationRecord): StoredApplication {
  const result = storedResult(record.result);
  return {
    id: record.id, jobId: record.jobId, jobTitle: record.job.title, company: record.job.company, url: record.job.url,
    status: record.status, kind: record.kind, applyUrl: record.applyUrl, filled: result.filled, summary: result.summary, note: record.note,
    inputTokens: record.inputTokens, cacheReadTokens: record.cacheReadTokens, outputTokens: record.outputTokens, costMicros: record.costMicros,
    startedAt: record.startedAt.toISOString(), finishedAt: record.finishedAt?.toISOString() ?? null,
    sessionId: record.sessionId, trackerId: record.job.trackerId, jobStatus: record.job.status, trackerChannel: record.trackerChannel,
  };
}

function toQuestion(record: QuestionRecord): QuestionView {
  return {
    id: record.id, applicationId: record.applicationId, jobId: record.application.jobId,
    jobTitle: record.application.job.title, company: record.application.job.company,
    applyUrl: record.application.applyUrl ?? record.application.job.url,
    text: record.text, answer: record.answer, status: record.status, telegramMessageId: record.telegramMessageId,
    createdAt: record.createdAt.toISOString(), answeredAt: record.answeredAt?.toISOString() ?? null,
  };
}

export type AttemptResult = Readonly<{
  status: ApplicationStatus;
  note: string;
  sessionId?: string | null;
  /** JSON of the agent's answer and the run facts. */
  result?: string | null;
  kind?: ApplicationKind;
  applyUrl?: string | null;
  /** Set when the attempt is sent: the `channel` of its Job-Tracker mark. */
  trackerChannel?: string;
  tokens: Readonly<{ input: number; cacheRead: number; output: number }>;
  costMicros: number;
  finishedAt: Date;
}>;

/** Attempts and questions belong to the owner of their job; every query filters by it. */
export class ApplicationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(ownerId: string, jobId: string, startedAt: Date): Promise<StoredApplication> {
    // The job is read first, so an attempt is never attached to another user's job.
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId: ownerId }, select: { id: true } });
    if (!job) throw new Error(`Вакансия ${jobId} не найдена у владельца`);
    return toApplication(await this.prisma.application.create({ data: { jobId, startedAt, status: 'running' }, include: withJob }));
  }

  async find(ownerId: string, id: string): Promise<StoredApplication | null> {
    const record = await this.prisma.application.findFirst({ where: { id, job: { userId: ownerId } }, include: withJob });
    return record ? toApplication(record) : null;
  }

  async list(ownerId: string, statuses?: readonly ApplicationStatus[]): Promise<StoredApplication[]> {
    const records = await this.prisma.application.findMany({
      where: { job: { userId: ownerId }, ...(statuses ? { status: { in: [...statuses] } } : {}) },
      include: withJob, orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    });
    return records.map(toApplication);
  }

  /** The fields of the job's latest attempt that stopped on questions: the draft a new fill starts from. */
  async latestDraft(ownerId: string, jobId: string): Promise<FilledField[]> {
    const record = await this.prisma.application.findFirst({
      where: { jobId, status: 'needs_input', job: { userId: ownerId } }, include: withJob, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    return record ? storedResult(record.result).filled : [];
  }

  /** Records the run's result while the attempt is still in one of `from`; false when it moved on. */
  async finish(ownerId: string, id: string, from: readonly ApplicationStatus[], result: AttemptResult): Promise<boolean> {
    const { count } = await this.prisma.application.updateMany({
      where: { id, status: { in: [...from] }, job: { userId: ownerId } },
      data: {
        status: result.status, note: result.note, finishedAt: result.finishedAt,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        ...(result.result !== undefined ? { result: result.result } : {}),
        ...(result.kind !== undefined ? { kind: result.kind } : {}),
        ...(result.applyUrl !== undefined ? { applyUrl: result.applyUrl } : {}),
        ...(result.trackerChannel !== undefined ? { trackerChannel: result.trackerChannel } : {}),
        // A submit adds its tokens to the fill run's.
        inputTokens: { increment: result.tokens.input }, cacheReadTokens: { increment: result.tokens.cacheRead },
        outputTokens: { increment: result.tokens.output }, costMicros: { increment: result.costMicros },
      },
    });
    return count > 0;
  }

  async setStatus(ownerId: string, id: string, from: readonly ApplicationStatus[], status: ApplicationStatus, note: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.application.updateMany({
      where: { id, status: { in: [...from] }, job: { userId: ownerId } },
      data: { status, note, finishedAt: at },
    });
    return count > 0;
  }

  /** Attempts left `running` by a run that died (crash, kill) for this job. */
  async failRunning(ownerId: string, jobId: string, note: string, at: Date): Promise<number> {
    const { count } = await this.prisma.application.updateMany({
      where: { jobId, status: 'running', job: { userId: ownerId } }, data: { status: 'failed', note, finishedAt: at },
    });
    return count;
  }

  async spentSince(ownerId: string, since: Date): Promise<number> {
    const total = await this.prisma.application.aggregate({
      where: { job: { userId: ownerId }, startedAt: { gte: since } }, _sum: { costMicros: true },
    });
    return total._sum.costMicros ?? 0;
  }

  // ── Questions ──

  async createQuestions(applicationId: string, texts: readonly string[], at: Date): Promise<QuestionView[]> {
    const created: QuestionView[] = [];
    for (const text of texts) {
      created.push(toQuestion(await this.prisma.question.create({ data: { applicationId, text, createdAt: at }, include: questionWithJob })));
    }
    return created;
  }

  async findQuestion(ownerId: string, id: string): Promise<QuestionView | null> {
    const record = await this.prisma.question.findFirst({ where: { id, application: { job: { userId: ownerId } } }, include: questionWithJob });
    return record ? toQuestion(record) : null;
  }

  async findQuestionByMessage(ownerId: string, messageId: string): Promise<QuestionView | null> {
    const record = await this.prisma.question.findFirst({
      where: { telegramMessageId: messageId, application: { job: { userId: ownerId } } }, include: questionWithJob,
    });
    return record ? toQuestion(record) : null;
  }

  async openQuestions(ownerId: string, applicationId?: string): Promise<QuestionView[]> {
    const records = await this.prisma.question.findMany({
      where: { status: 'open', application: { job: { userId: ownerId } }, ...(applicationId ? { applicationId } : {}) },
      include: questionWithJob, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return records.map(toQuestion);
  }

  async questionsOf(ownerId: string, applicationId: string): Promise<QuestionView[]> {
    const records = await this.prisma.question.findMany({
      where: { applicationId, application: { job: { userId: ownerId } } }, include: questionWithJob, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return records.map(toQuestion);
  }

  /** Only an open question takes an answer; false when it was answered meanwhile. */
  async answerQuestion(ownerId: string, id: string, answer: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.question.updateMany({
      where: { id, status: 'open', application: { job: { userId: ownerId } } }, data: { answer, status: 'answered', answeredAt: at },
    });
    return count > 0;
  }

  async setQuestionMessage(ownerId: string, id: string, messageId: string): Promise<boolean> {
    const { count } = await this.prisma.question.updateMany({
      where: { id, application: { job: { userId: ownerId } } }, data: { telegramMessageId: messageId },
    });
    return count > 0;
  }

  /** Answered questions of the job's attempts become `used` when a new fill of the job starts. */
  async markQuestionsUsed(ownerId: string, jobId: string): Promise<void> {
    await this.prisma.question.updateMany({
      where: { status: 'answered', application: { jobId, job: { userId: ownerId } } }, data: { status: 'used' },
    });
  }

  /** Open questions of a job that was rejected by hand are not asked any more. */
  async closeOpenQuestions(ownerId: string, applicationId: string): Promise<void> {
    await this.prisma.question.updateMany({
      where: { applicationId, status: 'open', application: { job: { userId: ownerId } } }, data: { status: 'used' },
    });
  }
}
