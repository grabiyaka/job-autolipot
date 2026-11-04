import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ApplicationError } from '../framework/core/errors.js';
import { ollamaScoringModel } from '../framework/composition/create-scorer.js';
import { createPrismaClient } from '../plugins/database.js';
import { OllamaHttpError, OllamaResponseError, OllamaUnavailableError } from '../plugins/ollama.js';
import type { OllamaClient } from '../plugins/ollama.js';
import { JobRepository } from '../src/jobs/JobRepository.js';
import { JobService } from '../src/jobs/JobService.js';
import type { JobInput } from '../src/jobs/JobTypes.js';
import { ScoringModelUnavailableError } from '../src/scoring/ScoringContracts.js';
import type { ScoringModel, ScoringModelRequest } from '../src/scoring/ScoringContracts.js';
import { ScoringService } from '../src/scoring/ScoringService.js';
import type { TrackerApi, TrackerProfile, TrackerPushReport } from '../src/trackers/TrackerTypes.js';
import { createTestDatabase } from './auth-fixture.js';

/** What the fake model answers for a job title. */
type Behaviour = number | 'broken' | 'down' | ((request: ScoringModelRequest) => Promise<number> | number);

function fakeModel(byTitle: Record<string, Behaviour>) {
  const calls: ScoringModelRequest[] = [];
  const model: ScoringModel = {
    defaultModel: 'fake-model',
    async chatJson(request, parse) {
      calls.push(request);
      const title = Object.keys(byTitle).find((candidate) => request.user.includes(`"title": "${candidate}"`));
      const behaviour = title === undefined ? 75 : byTitle[title]!;
      if (behaviour === 'down') throw new ScoringModelUnavailableError('Ollama недоступна');
      if (behaviour === 'broken') throw new Error('ответ не разобран после повтора');
      const score = typeof behaviour === 'number' ? behaviour : await behaviour(request);
      const content = JSON.stringify({ score, why: `Оценка ${score}.`, redFlags: score < 70 ? ['мимо'] : [], matchedSkills: [], missingSkills: [] });
      return { value: parse(content), model: request.model ?? 'fake-model', promptTokens: 800, evalTokens: 100, durationMs: 2000, attempts: 1 };
    },
  };
  return { model, calls };
}

const emptyPush: TrackerPushReport = { created: 0, backfilled: 0, duplicates: 0, alreadyApplied: 0, invalid: [], unevaluated: [], remaining: 0, error: null };

function fakeTracker(options: { profile?: TrackerProfile | Error; push?: Partial<TrackerPushReport> } = {}) {
  const pushes: { ownerId: string; model: string | undefined }[] = [];
  const profile = options.profile ?? { markdown: '# Candidate profile\n- Node.js', revision: 7, fetchedAt: new Date(), fromCache: false };
  const tracker: TrackerApi = {
    async profile() {
      if (profile instanceof Error) throw profile;
      return profile;
    },
    async pushQueued(ownerId, pushOptions) {
      pushes.push({ ownerId, model: pushOptions?.model });
      return { ...emptyPush, ...options.push };
    },
  };
  return { tracker, pushes };
}

describe('ScoringService on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let jobs: JobService;
  let ownerId: string;
  let strangerId: string;
  let counter = 0;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    jobs = new JobService(new JobRepository(database));
    const user = (email: string) => database.user.create({ data: { email, name: email, passwordHash: 'unused' } });
    ownerId = (await user('score-owner@example.test')).id;
    strangerId = (await user('score-stranger@example.test')).id;
  }, 60_000);

  beforeEach(async () => { await database.job.deleteMany(); });

  afterAll(async () => {
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  async function found(userId: string, card: Partial<JobInput> = {}): Promise<string> {
    const result = await jobs.recordFound(userId, [{
      url: `https://score.example.test/${++counter}`, source: 'board', title: `Job ${counter}`, company: 'Acme',
      description: 'Node.js backend', ...card,
    }]);
    const id = result.jobIds[0]!;
    // Scoring goes oldest first; jobs saved in the same millisecond would tie and fall back to random IDs.
    await database.job.update({ where: { id }, data: { foundAt: new Date(Date.UTC(2026, 0, 1) + counter * 1000) } });
    return id;
  }
  const job = (id: string) => database.job.findUniqueOrThrow({ where: { id } });

  it('queues from the threshold, rejects below it and stores score, why, red flags and profile revision', async () => {
    const low = await found(ownerId, { title: 'Low' });
    const edge = await found(ownerId, { title: 'Edge' });
    const { model, calls } = fakeModel({ Low: 49, Edge: 50 });
    const { tracker, pushes } = fakeTracker();

    const report = await new ScoringService(jobs, tracker, model).scoreFound(ownerId, { dryRun: false, push: true });

    expect(await job(low)).toMatchObject({ status: 'rejected', score: 49, why: 'Оценка 49.', redFlags: '["мимо"]', profileRevision: 7 });
    expect(await job(edge)).toMatchObject({ status: 'queued', score: 50, why: 'Оценка 50.', profileRevision: 7 });
    expect(report).toMatchObject({
      model: 'fake-model', threshold: 50, profile: { revision: 7, fromCache: false }, stopped: 'end',
      counts: { queued: 1, rejected: 1, skipped: 0, errors: 0, changed: 0 },
      scored: 2, secondsPerJob: 2, promptTokens: 1600, evalTokens: 200, push: emptyPush,
    });
    expect(report.lines.map((line) => line.outcome)).toEqual(['rejected', 'queued']);
    expect(calls[0]?.system).toContain('# Candidate profile');
    expect(pushes).toEqual([{ ownerId, model: 'fake-model' }]);
  });

  it('honours a custom threshold and model', async () => {
    const id = await found(ownerId, { title: 'Good' });
    const { model, calls } = fakeModel({ Good: 75 });
    const { tracker, pushes } = fakeTracker();
    await new ScoringService(jobs, tracker, model).scoreFound(ownerId, { dryRun: false, push: true, threshold: 80, model: 'qwen3.5:4b' });
    expect((await job(id)).status).toBe('rejected');
    expect(calls[0]?.model).toBe('qwen3.5:4b');
    expect(pushes[0]?.model).toBe('qwen3.5:4b');
  });

  it('skips a repeat of a job already past scoring without asking the model', async () => {
    const earlier = await found(ownerId, { title: 'Node.js Engineer', company: 'Acme Ltd' });
    await jobs.recordScore(ownerId, earlier, { score: 80 });
    await jobs.recordDecision(ownerId, earlier, 'queued');
    const repeat = await found(ownerId, { title: 'node.js  engineer!', company: 'ACME ltd' });
    const { model, calls } = fakeModel({});

    const report = await new ScoringService(jobs, fakeTracker().tracker, model).scoreFound(ownerId, { dryRun: false, push: false });

    expect(calls).toHaveLength(0);
    expect(await job(repeat)).toMatchObject({ status: 'skipped', why: `повтор: Node.js Engineer — Acme Ltd (${earlier})`, score: null });
    expect(report.counts.skipped).toBe(1);
    expect(report.lines[0]).toMatchObject({ outcome: 'skipped', twin: { id: earlier } });
    expect(report.push).toBeNull();
  });

  it('skips a repeat found in the same run', async () => {
    const first = await found(ownerId, { title: 'Backend Dev' });
    const second = await found(ownerId, { title: 'Backend Dev' });
    const { model, calls } = fakeModel({});
    await new ScoringService(jobs, fakeTracker().tracker, model).scoreFound(ownerId, { dryRun: false, push: false });
    expect(calls).toHaveLength(1);
    expect((await job(first)).status).toBe('queued');
    expect(await job(second)).toMatchObject({ status: 'skipped', why: `повтор: Backend Dev — Acme (${first})` });
  });

  it('dry run writes nothing, does not push, and still finds repeats inside the run', async () => {
    const first = await found(ownerId, { title: 'Backend Dev' });
    const second = await found(ownerId, { title: 'Backend Dev' });
    const { model, calls } = fakeModel({ 'Backend Dev': 90 });
    const { tracker, pushes } = fakeTracker();

    const report = await new ScoringService(jobs, tracker, model).scoreFound(ownerId, { dryRun: true, push: true });

    expect(calls).toHaveLength(1);
    expect(report.lines).toEqual([
      expect.objectContaining({ jobId: first, outcome: 'queued', score: 90 }),
      expect.objectContaining({ jobId: second, outcome: 'skipped', twin: expect.objectContaining({ id: first }) }),
    ]);
    for (const id of [first, second]) expect(await job(id)).toMatchObject({ status: 'found', score: null, why: null });
    expect(pushes).toHaveLength(0);
    expect(report).toMatchObject({ dryRun: true, push: null });
  });

  it('a broken answer fails only its job, which stays found', async () => {
    const broken = await found(ownerId, { title: 'Broken' });
    const fine = await found(ownerId, { title: 'Fine' });
    const lines: string[] = [];
    const report = await new ScoringService(jobs, fakeTracker().tracker, fakeModel({ Broken: 'broken', Fine: 85 }).model)
      .scoreFound(ownerId, { dryRun: false, push: false, onJob: (line) => lines.push(line.outcome) });

    expect((await job(broken)).status).toBe('found');
    expect((await job(fine)).status).toBe('queued');
    expect(report.counts).toMatchObject({ errors: 1, queued: 1 });
    expect(report.lines[0]).toMatchObject({ outcome: 'error', message: 'ответ не разобран после повтора' });
    expect(lines).toEqual(['error', 'queued']);
  });

  it('an unavailable model stops the run; earlier decisions are kept and queued jobs are still pushed', async () => {
    const before = await found(ownerId, { title: 'Before' });
    const down = await found(ownerId, { title: 'Down' });
    const after = await found(ownerId, { title: 'After' });
    const { model, calls } = fakeModel({ Before: 80, Down: 'down' });
    const { tracker, pushes } = fakeTracker();

    const report = await new ScoringService(jobs, tracker, model).scoreFound(ownerId, { dryRun: false, push: true });

    expect(calls).toHaveLength(2);
    expect((await job(before)).status).toBe('queued');
    for (const id of [down, after]) expect((await job(id)).status).toBe('found');
    expect(report).toMatchObject({ stopped: 'model_unavailable', error: { code: 'MODEL_UNAVAILABLE', message: 'Ollama недоступна' } });
    expect(report.lines).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it('a Job-Tracker failure while pushing is reported and the jobs stay queued for the next run', async () => {
    const id = await found(ownerId, { title: 'Good' });
    const { tracker } = fakeTracker({ push: { error: 'Job-Tracker недоступен', remaining: 1 } });
    const report = await new ScoringService(jobs, tracker, fakeModel({ Good: 88 }).model).scoreFound(ownerId, { dryRun: false, push: true });
    expect(report.push).toMatchObject({ error: 'Job-Tracker недоступен', remaining: 1 });
    expect((await job(id)).status).toBe('queued');
    expect((await jobs.listUnsynced(ownerId)).map((unsynced) => unsynced.id)).toEqual([id]);
  });

  it('a job whose status changed during scoring is counted and left alone', async () => {
    const id = await found(ownerId, { title: 'Moved' });
    const { model } = fakeModel({ Moved: async () => { await jobs.recordDecision(ownerId, id, 'skipped', 'вручную'); return 90; } });
    const report = await new ScoringService(jobs, fakeTracker().tracker, model).scoreFound(ownerId, { dryRun: false, push: false });
    expect(report.counts.changed).toBe(1);
    expect(await job(id)).toMatchObject({ status: 'skipped', why: 'вручную' });
  });

  it('stops for this owner when the profile is unavailable, scoring nothing', async () => {
    const id = await found(ownerId);
    const { model, calls } = fakeModel({});
    const { tracker, pushes } = fakeTracker({ profile: new ApplicationError('TRACKER_NOT_LINKED', 'Job-Tracker не привязан к этому пользователю.', 404) });
    const report = await new ScoringService(jobs, tracker, model).scoreFound(ownerId, { dryRun: false, push: true });
    expect(report).toMatchObject({ stopped: 'profile', error: { code: 'TRACKER_NOT_LINKED' }, profile: null });
    expect(calls).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect((await job(id)).status).toBe('found');
  });

  it('reports a profile served from cache', async () => {
    await found(ownerId);
    const { tracker } = fakeTracker({ profile: { markdown: '# P', revision: 3, fetchedAt: new Date(), fromCache: true } });
    const report = await new ScoringService(jobs, tracker, fakeModel({}).model).scoreFound(ownerId, { dryRun: false, push: false });
    expect(report.profile).toEqual({ revision: 3, fromCache: true });
    expect(report.lines).toHaveLength(1);
  });

  it("scores only the owner's jobs and does not treat another owner's job as a repeat", async () => {
    const stranger = await found(strangerId, { title: 'Shared Title' });
    await jobs.recordScore(strangerId, stranger, { score: 90 });
    await jobs.recordDecision(strangerId, stranger, 'queued');
    const strangerFound = await found(strangerId, { title: 'Other' });
    const own = await found(ownerId, { title: 'Shared Title' });
    const { model, calls } = fakeModel({});

    const report = await new ScoringService(jobs, fakeTracker().tracker, model).scoreFound(ownerId, { dryRun: false, push: false });

    expect(calls).toHaveLength(1);
    expect(report.lines.map((line) => line.jobId)).toEqual([own]);
    expect((await job(own)).status).toBe('queued');
    expect((await job(strangerFound)).status).toBe('found');
  });

  it('honours the limit', async () => {
    await found(ownerId);
    await found(ownerId);
    await found(ownerId);
    const report = await new ScoringService(jobs, fakeTracker().tracker, fakeModel({}).model).scoreFound(ownerId, { dryRun: false, push: false, limit: 2 });
    expect(report.lines).toHaveLength(2);
  });

  it('the signal finishes the current job and stops, without pushing', async () => {
    const interrupt = new AbortController();
    const first = await found(ownerId, { title: 'First' });
    const second = await found(ownerId, { title: 'Second' });
    const { model } = fakeModel({ First: () => { interrupt.abort(); return 80; } });
    const { tracker, pushes } = fakeTracker();

    const report = await new ScoringService(jobs, tracker, model).scoreFound(ownerId, { dryRun: false, push: true, signal: interrupt.signal });

    expect((await job(first)).status).toBe('queued');
    expect((await job(second)).status).toBe('found');
    expect(report.stopped).toBe('aborted');
    expect(pushes).toHaveLength(0);
  });
});

describe('Ollama as the scoring model', () => {
  const request = { system: 's', user: 'u', schema: {} };
  const ollama = (error: Error): OllamaClient => ({
    config: { baseUrl: 'http://x', model: 'm', numCtx: 8192, numPredict: 1024, timeoutMs: 1 },
    chatJson: () => Promise.reject(error),
  });

  it('turns an unreachable server and an HTTP error into "unavailable", and keeps a bad answer per job', async () => {
    expect(ollamaScoringModel(ollama(new OllamaUnavailableError('x'))).defaultModel).toBe('m');
    await expect(ollamaScoringModel(ollama(new OllamaUnavailableError('down'))).chatJson(request, String))
      .rejects.toBeInstanceOf(ScoringModelUnavailableError);
    await expect(ollamaScoringModel(ollama(new OllamaHttpError(404, 'model not found'))).chatJson(request, String))
      .rejects.toThrow(ScoringModelUnavailableError);
    const bad = await ollamaScoringModel(ollama(new OllamaResponseError('bad'))).chatJson(request, String).catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(OllamaResponseError);
  });
});
