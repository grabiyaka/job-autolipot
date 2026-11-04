import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { createTrackerService } from '../framework/composition/create-trackers.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../plugins/database.js';
import { JobRepository } from '../src/jobs/JobRepository.js';
import { JobService } from '../src/jobs/JobService.js';
import type { PipelineJob } from '../src/jobs/JobTypes.js';
import { trackerJob, trackerVerdict } from '../src/trackers/TrackerService.js';
import type { TrackerProfileView, TrackerStatus } from '../src/trackers/TrackerService.js';
import { TrackerError } from '../src/trackers/TrackerTypes.js';
import type {
  JobTrackerClient, TrackerEvaluationInput, TrackerJobInput, TrackerJobPage, TrackerProfileContext, TrackerPushReport, TrackerPushResult,
  TrackerWorklistQuery,
} from '../src/trackers/TrackerTypes.js';
import { createAuthFixture, createTestDatabase, testAuth } from './auth-fixture.js';
import type { AuthHeaders } from './auth-fixture.js';

/**
 * In-memory JT: the vacancy URL path decides the batch outcome (`/dup`, `/applied`, `/bad`, anything else is created).
 * The worklist pages by two and starts with a job someone else added to JT.
 */
class FakeTracker implements JobTrackerClient {
  email = '';
  profileState = { revision: 3, markdown: '# Candidate profile\n', etag: '"r3"' };
  profileFailure: TrackerError | null = null;
  pushFailure: TrackerError | null = null;
  /** Evaluations after this many succeed fail with 429. */
  evaluationBudget = Infinity;
  whoamiCalls = 0;
  profileCalls: (string | null | undefined)[] = [];
  pushed: TrackerJobInput[][] = [];
  evaluations: { trackerJobId: string; evaluation: TrackerEvaluationInput }[] = [];
  created = 0;
  /** JT opportunity IDs in creation order, including one this app did not create. */
  opportunities: string[] = ['jt-foreign'];
  worklistPages = 0;

  async whoami() {
    this.whoamiCalls++;
    return { user: { id: 'jt-user', email: this.email, name: null } };
  }

  async profileContext(etag?: string | null): Promise<TrackerProfileContext> {
    this.profileCalls.push(etag);
    if (this.profileFailure) throw this.profileFailure;
    if (etag === this.profileState.etag) return { status: 'not_modified' };
    return { status: 'modified', ...this.profileState };
  }

  async pushJobs(items: readonly TrackerJobInput[]): Promise<TrackerPushResult[]> {
    if (this.pushFailure) throw this.pushFailure;
    this.pushed.push([...items]);
    return items.map((item, index): TrackerPushResult => {
      if (item.vacancyUrl.includes('/dup')) return { index, status: 'duplicate_opportunity', jobId: 'jt-existing' };
      if (item.vacancyUrl.includes('/applied')) return { index, status: 'already_applied', applicationId: 'app-1' };
      if (item.vacancyUrl.includes('/bad')) return { index, status: 'invalid', errors: ['companyName: Required'] };
      const jobId = `jt-${++this.created}`;
      this.opportunities.push(jobId);
      return { index, status: 'created', jobId };
    });
  }

  async listJobs(query: TrackerWorklistQuery): Promise<TrackerJobPage> {
    this.worklistPages++;
    // A keyset cursor like JT's: the position after the last row of the previous page.
    const evaluated = new Set(this.evaluations.map((entry) => entry.trackerJobId));
    const after = query.cursor ? this.opportunities.indexOf(query.cursor) + 1 : 0;
    const rows = this.opportunities.slice(after).filter((id) => query.evaluation !== 'none' || !evaluated.has(id));
    const ids = rows.slice(0, 2);
    return { ids, nextCursor: rows.length > 2 ? ids[1]! : null };
  }

  async recordEvaluation(trackerJobId: string, evaluation: TrackerEvaluationInput) {
    if (this.evaluations.length >= this.evaluationBudget) throw new TrackerError('rate_limited', 'Job-Tracker: превышен лимит запросов.', 429);
    this.evaluations.push({ trackerJobId, evaluation });
  }
}

describe('Trackers: Job-Tracker link, profile cache and push on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let unconfigured: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;
  let jobs: JobService;
  let fake: FakeTracker;
  let owner: AuthHeaders;
  let stranger: AuthHeaders;
  let ownerId: string;
  const clock = { now: () => new Date('2026-11-03T10:00:00Z') };
  const users = { profile: async (id: string) => (id === ownerId ? { id, email: auth.user.email, name: 'Owner', role: 'user' as const } : null) };

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    fake = new FakeTracker();
    server = await buildServer({ databaseUrl: testDatabase.url, logger: false, auth: testAuth, tracker: fake });
    unconfigured = await buildServer({ databaseUrl: testDatabase.url, logger: false, auth: testAuth });
    auth = await createAuthFixture(server, database);
    jobs = new JobService(new JobRepository(database));
    owner = auth.userHeaders;
    stranger = auth.adminHeaders;
    ownerId = auth.user.id;
    // Case differs on purpose: emails match without regard to case.
    fake.email = auth.user.email.toUpperCase();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await unconfigured?.close();
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  beforeEach(async () => {
    await database.job.deleteMany({});
    await database.trackerProfile.deleteMany({});
    Object.assign(fake, { created: 0, opportunities: ['jt-foreign'], worklistPages: 0, profileState: { revision: 3, markdown: '# Candidate profile\n', etag: '"r3"' }, profileFailure: null, pushFailure: null, evaluationBudget: Infinity, profileCalls: [], pushed: [], evaluations: [] });
  });

  const get = (headers: AuthHeaders, url: string) => server.inject({ method: 'GET', url, headers });
  const push = (headers: AuthHeaders) => server.inject({ method: 'POST', url: '/api/tracker/push', headers });
  const service = (client: JobTrackerClient) => createTrackerService(database, client, jobs, users, clock);

  /** Creates queued jobs; `score: null` means queued by hand without a score. */
  async function queued(...specs: { path: string; score: number | null; company?: string }[]): Promise<string[]> {
    const found = await jobs.recordFound(ownerId, specs.map((spec) => ({
      url: `https://jobs.example.test${spec.path}`, source: 'linkedin', title: `Engineer ${spec.path}`,
      company: spec.company ?? 'Acme', externalId: spec.path.slice(1), description: 'Node.js, TypeScript', location: 'Remote',
    })));
    for (const [index, id] of found.jobIds.entries()) {
      const score = specs[index]!.score;
      if (score !== null) await jobs.recordScore(ownerId, id, { score, why: `why ${score}`, redFlags: ['on-call'], profileRevision: 3 });
      await jobs.recordDecision(ownerId, id, 'queued');
    }
    return found.jobIds;
  }

  it('maps scores to JT verdicts and jobs to JT fields', () => {
    expect([100, 80, 79, 70, 69, 50, 49, 0].map(trackerVerdict)).toEqual([
      'STRONG_FIT', 'STRONG_FIT', 'GOOD_FIT', 'GOOD_FIT', 'WEAK_FIT', 'WEAK_FIT', 'NOT_A_FIT', 'NOT_A_FIT',
    ]);
    const job: PipelineJob = {
      id: 'j', url: 'https://jobs.example.test/1', source: 'linkedin', externalId: null, title: 'Backend', company: 'Acme',
      location: ' ', description: 'Text', postedAt: '2026-11-01T00:00:00.000Z', score: 80, why: null, redFlags: [],
      status: 'queued', trackerId: null, profileRevision: 3,
    };
    expect(trackerJob(job)).toEqual({
      jobTitle: 'Backend', companyName: 'Acme', vacancyUrl: 'https://jobs.example.test/1',
      jobDescription: 'Text', source: 'linkedin', postedAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('answers "not configured" without JOB_TRACKER_* and still starts', async () => {
    const status = await unconfigured.inject({ method: 'GET', url: '/api/tracker/status', headers: owner });
    expect(status.json<TrackerStatus>()).toEqual({ configured: false, linked: false, profile: null, error: null });
    const profile = await unconfigured.inject({ method: 'GET', url: '/api/tracker/profile', headers: owner });
    expect(profile.statusCode).toBe(503);
    expect(profile.json()).toMatchObject({ error: { code: 'TRACKER_NOT_CONFIGURED' } });
  });

  it('links only the user whose email is the JT token owner; others get 404', async () => {
    expect((await get(owner, '/api/tracker/status')).json<TrackerStatus>()).toEqual({ configured: true, linked: true, profile: null, error: null });
    expect((await get(stranger, '/api/tracker/status')).json<TrackerStatus>()).toEqual({ configured: true, linked: false, profile: null, error: null });

    const profile = await get(stranger, '/api/tracker/profile');
    expect(profile.statusCode).toBe(404);
    expect(profile.json()).toMatchObject({ error: { code: 'TRACKER_NOT_LINKED' } });
    expect((await push(stranger)).statusCode).toBe(404);
    expect(fake.profileCalls).toEqual([]);
    expect(fake.pushed).toEqual([]);
  });

  it('caches the profile, serves the copy without asking JT and refreshes it by ETag', async () => {
    const first = await get(owner, '/api/tracker/profile');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<TrackerProfileView>()).toMatchObject({ markdown: '# Candidate profile\n', revision: 3, fromCache: false });

    expect((await get(owner, '/api/tracker/profile')).json<TrackerProfileView>()).toMatchObject({ revision: 3, fromCache: true });
    expect(fake.profileCalls).toEqual([undefined]);

    const refreshed = await get(owner, '/api/tracker/profile?refresh=true');
    expect(refreshed.json<TrackerProfileView>()).toMatchObject({ revision: 3, fromCache: false });
    expect(fake.profileCalls).toEqual([undefined, '"r3"']);

    expect((await get(owner, '/api/tracker/status')).json<TrackerStatus>().profile).toMatchObject({ revision: 3 });

    fake.profileState = { revision: 4, markdown: '# Updated\n', etag: '"r4"' };
    await expect(service(fake).profile(ownerId)).resolves.toMatchObject({ revision: 4, markdown: '# Updated\n', fromCache: false });
    expect(await database.trackerProfile.findUnique({ where: { userId: ownerId } })).toMatchObject({ revision: 4, etag: '"r4"' });
  });

  it('falls back to the stored profile when JT is unreachable, and fails without one', async () => {
    fake.profileFailure = new TrackerError('unavailable', 'Job-Tracker недоступен.');
    await expect(service(fake).profile(ownerId)).rejects.toMatchObject({ code: 'TRACKER_UNAVAILABLE', statusCode: 503 });

    fake.profileFailure = null;
    await service(fake).profile(ownerId);
    fake.profileFailure = new TrackerError('unavailable', 'Job-Tracker недоступен.');
    await expect(service(fake).profile(ownerId)).resolves.toMatchObject({ revision: 3, fromCache: true });

    // A JT that is down cannot confirm the link either; the stored copy is still served.
    const down = new FakeTracker();
    down.whoami = () => Promise.reject(new TrackerError('unavailable', 'Job-Tracker недоступен.'));
    await expect(service(down).profile(ownerId)).resolves.toMatchObject({ revision: 3, fromCache: true });

    fake.profileFailure = new TrackerError('unauthorized', 'Job-Tracker отклонил токен (HTTP 401).', 401);
    await expect(service(fake).profile(ownerId)).rejects.toMatchObject({ code: 'TRACKER_UNAUTHORIZED', statusCode: 502 });
  });

  it('pushes queued jobs with their evaluations and settles every outcome', async () => {
    const [scored, manual, duplicate, applied, invalid] = await queued(
      { path: '/scored', score: 85 }, { path: '/manual', score: null }, { path: '/dup', score: 72 },
      { path: '/applied', score: 60 }, { path: '/bad', score: 40, company: 'Bad Co' },
    );
    const report = await service(fake).pushQueued(ownerId, { model: 'qwen3:4b' });
    expect(report).toEqual<TrackerPushReport>({
      created: 2, backfilled: 0, duplicates: 1, alreadyApplied: 1, invalid: [{ jobId: invalid!, errors: ['companyName: Required'] }],
      unevaluated: [], remaining: 0, error: null,
    });
    expect(fake.pushed[0]![0]).toEqual({
      jobTitle: 'Engineer /scored', companyName: 'Acme', vacancyUrl: 'https://jobs.example.test/scored',
      jobDescription: 'Node.js, TypeScript', location: 'Remote', source: 'linkedin', externalId: 'scored',
    });
    // The job queued by hand has no score, so it is sent without an evaluation.
    expect(fake.evaluations).toEqual([{
      trackerJobId: 'jt-1',
      evaluation: {
        score: 85, verdict: 'STRONG_FIT', summary: 'why 85', redFlags: ['on-call'], profileRevision: 3,
        evaluatorName: 'job-autopilot', model: 'qwen3:4b',
      },
    }]);

    const actor = { id: ownerId, role: 'user' } as const;
    expect(await jobs.get(actor, scored!)).toMatchObject({ status: 'queued' });
    expect((await database.job.findUnique({ where: { id: scored! } }))?.trackerId).toBe('jt-1');
    expect((await database.job.findUnique({ where: { id: manual! } }))?.trackerId).toBe('jt-2');
    expect(await jobs.get(actor, duplicate!)).toMatchObject({ status: 'skipped', why: 'уже в Job-Tracker' });
    expect(await jobs.get(actor, applied!)).toMatchObject({ status: 'skipped', why: 'уже подавался' });
    expect(await jobs.get(actor, invalid!)).toMatchObject({ status: 'queued' });

    // Only the invalid job is still unsynced; a repeated run sends just that one.
    expect((await jobs.listUnsynced(ownerId)).map((job) => job.id)).toEqual([invalid]);
    await service(fake).pushQueued(ownerId);
    expect(fake.pushed[1]!.map((item) => item.vacancyUrl)).toEqual(['https://jobs.example.test/bad']);
  });

  it('reports a JT outage and sends the jobs on the next run', async () => {
    await queued({ path: '/a', score: 90 }, { path: '/b', score: 55 });
    fake.pushFailure = new TrackerError('unavailable', 'Job-Tracker недоступен (таймаут).');
    const failed = await push(owner);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json<TrackerPushReport>()).toMatchObject({ created: 0, remaining: 2, error: 'Job-Tracker недоступен (таймаут).' });
    expect(await jobs.listUnsynced(ownerId)).toHaveLength(2);

    fake.pushFailure = null;
    expect((await push(owner)).json<TrackerPushReport>()).toMatchObject({ created: 2, remaining: 0, error: null });
    expect(fake.evaluations.map((entry) => entry.evaluation.verdict).sort()).toEqual(['STRONG_FIT', 'WEAK_FIT']);
    expect(await jobs.listUnsynced(ownerId)).toEqual([]);
  });

  it('marks created jobs as synced even when JT stops taking evaluations mid-batch', async () => {
    // Jobs found in one call share foundAt, so their push order is not fixed; assertions ignore it.
    const ids = await queued({ path: '/a', score: 90 }, { path: '/b', score: 80 }, { path: '/c', score: 70 });
    fake.evaluationBudget = 1;
    const report = await service(fake).pushQueued(ownerId);
    expect(report).toMatchObject({ created: 3, remaining: 0, error: 'Job-Tracker: превышен лимит запросов.' });
    expect(fake.evaluations.map((entry) => entry.trackerJobId)).toEqual(['jt-1']);
    const evaluatedJob = await jobs.findByTrackerId(ownerId, 'jt-1');
    expect([...report.unevaluated].sort()).toEqual(ids.filter((id) => id !== evaluatedJob!.id).sort());
    expect(await jobs.listUnsynced(ownerId)).toEqual([]);

    // The next run finds them in JT's evaluation=none worklist (two pages here) and sends what was missing.
    fake.evaluationBudget = Infinity;
    fake.worklistPages = 0;
    expect(await service(fake).pushQueued(ownerId)).toMatchObject({ created: 0, backfilled: 2, remaining: 0, error: null });
    expect(fake.worklistPages).toBe(2);
    expect(fake.evaluations.map((entry) => entry.evaluation.score).sort()).toEqual([70, 80, 90]);
    expect(fake.evaluations.map((entry) => entry.trackerJobId).sort()).toEqual(['jt-1', 'jt-2', 'jt-3']);
    expect(fake.pushed).toHaveLength(1);

    // Nothing is sent twice; the foreign JT job stays unevaluated.
    expect(await service(fake).pushQueued(ownerId)).toMatchObject({ backfilled: 0, error: null });
    expect(fake.evaluations).toHaveLength(3);
  });

  it('finds a job by its Job-Tracker ID only for its owner', async () => {
    const [id] = await queued({ path: '/linked', score: 75 });
    await jobs.markSynced(ownerId, id!, 'jt-linked');
    expect(await jobs.findByTrackerId(ownerId, 'jt-linked')).toMatchObject({ id, trackerId: 'jt-linked' });
    expect(await jobs.findByTrackerId(auth.admin.id, 'jt-linked')).toBeNull();
    expect(await jobs.findByTrackerId(ownerId, 'jt-missing')).toBeNull();
  });

  it('sends one batch of 50 per run and the rest on the next run', async () => {
    await queued(...Array.from({ length: 52 }, (_, index) => ({ path: `/bulk-${index}`, score: null })));
    expect(await service(fake).pushQueued(ownerId)).toMatchObject({ created: 50, remaining: 2 });
    expect(fake.pushed[0]).toHaveLength(50);
    expect(await service(fake).pushQueued(ownerId)).toMatchObject({ created: 2, remaining: 0 });
  });
});
