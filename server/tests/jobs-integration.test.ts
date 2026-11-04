import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../plugins/database.js';
import { JobRepository } from '../src/jobs/JobRepository.js';
import { JobService } from '../src/jobs/JobService.js';
import type { Job, JobInput, JobPage } from '../src/jobs/JobService.js';
import { createAuthFixture, createTestDatabase, testAuth } from './auth-fixture.js';
import type { AuthHeaders } from './auth-fixture.js';

describe('Jobs: owner-scoped HTTP API and pipeline API on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;
  let jobs: JobService;
  let owner: AuthHeaders;
  let stranger: AuthHeaders;
  let ownerId: string;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    server = await buildServer({ databaseUrl: testDatabase.url, logger: false, auth: testAuth });
    auth = await createAuthFixture(server, database);
    jobs = new JobService(new JobRepository(database));
    owner = auth.userHeaders;
    stranger = auth.adminHeaders;
    ownerId = auth.user.id;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  const create = (headers: AuthHeaders, payload: object) => server.inject({ method: 'POST', url: '/api/jobs', headers, payload });
  const list = async (headers: AuthHeaders, query = '') => {
    const response = await server.inject({ method: 'GET', url: `/api/jobs${query}`, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<JobPage>();
  };

  it('adds a job by hand, hides it from other users and rejects the same URL twice', async () => {
    const created = await create(owner, {
      url: 'https://jobs.example.test/manual#top', title: 'TypeScript developer', company: 'Manual Co', description: 'Full text',
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = created.json<Job>();
    expect(job).toMatchObject({
      url: 'https://jobs.example.test/manual', source: 'manual', status: 'found', score: null, redFlags: [], description: 'Full text',
    });
    expect(created.body).not.toContain('raw');

    expect((await server.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: owner })).json<Job>()).toEqual(job);
    expect((await server.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: stranger })).statusCode).toBe(404);

    const repeated = await create(owner, { url: 'https://jobs.example.test/manual', title: 'Again', company: 'Manual Co' });
    expect(repeated.statusCode, repeated.body).toBe(409);
    const sameUrlForAnotherUser = await create(stranger, { url: 'https://jobs.example.test/manual', title: 'Same job', company: 'Manual Co' });
    expect(sameUrlForAnotherUser.statusCode, sameUrlForAnotherUser.body).toBe(201);
  });

  it.each([
    {}, { url: 'https://jobs.example.test/x', title: 'No company' },
    { url: 'notaurl', title: 'T', company: 'C' },
    { url: 'https://jobs.example.test/x', title: 'T', company: 'C', status: 'applied' },
  ])('rejects malformed manual input %#', async (payload) => {
    expect((await create(owner, payload)).statusCode).toBe(400);
  });

  it('records collected listings for the owner and reports duplicates and invalid cards', async () => {
    const first = await jobs.recordFound(ownerId, [
      { url: 'https://board.example.test/1', source: 'board', externalId: 'b1', title: 'Node.js engineer', company: 'Alpha' },
      { url: 'https://board.example.test/2', source: 'board', externalId: 'b2', title: 'Vue developer', company: 'Beta' },
      { url: 'https://board.example.test/2#again', source: 'board', title: 'Vue developer', company: 'Beta' },
      { url: 'https://board.example.test/3', source: 'board', title: '', company: 'Broken' },
    ]);
    expect(first).toMatchObject({ created: 2, duplicates: 1, invalid: 1 });
    expect(first.jobIds).toHaveLength(2);

    const second = await jobs.recordFound(ownerId, [
      { url: 'https://board.example.test/1', source: 'board', title: 'Node.js engineer', company: 'Alpha' },
      { url: 'https://board.example.test/moved', source: 'board', externalId: 'b2', title: 'Vue developer', company: 'Beta' },
      { url: 'https://board.example.test/4', source: 'board', externalId: 'b4', title: 'Fullstack', company: 'Gamma' },
    ]);
    expect(second).toMatchObject({ created: 1, duplicates: 2, invalid: 0 });

    expect(await jobs.unknownUrls(ownerId, [
      'https://board.example.test/1#x', 'https://board.example.test/new', 'not a url',
    ])).toEqual(['https://board.example.test/new']);
    expect(await jobs.unknownUrls(auth.admin.id, ['https://board.example.test/1'])).toEqual(['https://board.example.test/1']);
  });

  it('filters, searches, sorts by score and pages only through the owner jobs', async () => {
    const boardJobs = await list(owner, '?source=board');
    expect(boardJobs.total).toBe(3);
    const [alpha, beta] = ['Alpha', 'Beta'].map((company) => boardJobs.items.find((job) => job.company === company)!);
    await jobs.recordScore(ownerId, alpha!.id, { score: 40, redFlags: ['relocation'] });
    await jobs.recordScore(ownerId, beta!.id, { score: 90, why: 'Vue + TypeScript' });

    const byScore = await list(owner, '?sort=score&source=board');
    expect(byScore.items.map((job) => job.score)).toEqual([90, 40, null]);
    expect(byScore.items[1]).toMatchObject({ redFlags: ['relocation'], status: 'scored' });

    expect((await list(owner, '?status=scored')).total).toBe(2);
    expect((await list(owner, '?search=vue')).items.map((job) => job.company)).toEqual(['Beta']);
    expect((await list(owner, '?search=ALPHA')).items.map((job) => job.company)).toEqual(['Alpha']);
    const page = await list(owner, '?limit=2&page=2');
    expect(page).toMatchObject({ total: 4, page: 2, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect((await list(stranger)).items.every((job) => job.company === 'Manual Co')).toBe(true);

    for (const query of ['?page=0', '?limit=101', '?status=done', '?sort=random', '?owner=x']) {
      const response = await server.inject({ method: 'GET', url: `/api/jobs${query}`, headers: owner });
      expect(response.statusCode, `${query}: ${response.body}`).toBe(400);
    }
  });

  it('lets the owner decide on a job and blocks system statuses and invalid paths', async () => {
    const [job] = (await list(owner, '?status=scored&sort=score')).items;
    const patch = (headers: AuthHeaders, status: string) => server.inject({
      method: 'PATCH', url: `/api/jobs/${job!.id}`, headers, payload: { status },
    });
    expect((await patch(stranger, 'queued')).statusCode).toBe(404);
    expect((await patch(owner, 'applied')).statusCode).toBe(400);

    const queued = await patch(owner, 'queued');
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json<Job>().status).toBe('queued');
    expect((await patch(owner, 'queued')).statusCode).toBe(409);

    await jobs.recordStatus(ownerId, job!.id, 'applying');
    await expect(jobs.recordScore(ownerId, job!.id, { score: 10 })).rejects.toMatchObject({ statusCode: 409 });
    expect((await patch(owner, 'skipped')).statusCode).toBe(409);
    expect((await jobs.recordStatus(ownerId, job!.id, 'applied')).status).toBe('applied');
    await expect(jobs.recordStatus(auth.admin.id, job!.id, 'queued')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('counts the owner jobs by status', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/jobs/summary', headers: owner });
    expect(response.statusCode, response.body).toBe(200);
    const summary = response.json<{ total: number; counts: Record<string, number> }>();
    expect(summary.total).toBe(4);
    expect(summary.counts).toMatchObject({ found: 2, scored: 1, applied: 1, queued: 0 });
  });

  it('deletes only the owner job', async () => {
    const [job] = (await list(owner, '?source=manual')).items;
    expect((await server.inject({ method: 'DELETE', url: `/api/jobs/${job!.id}`, headers: stranger })).statusCode).toBe(404);
    const removed = await server.inject({ method: 'DELETE', url: `/api/jobs/${job!.id}`, headers: owner });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await server.inject({ method: 'DELETE', url: `/api/jobs/${job!.id}`, headers: owner })).statusCode).toBe(404);
  });

  it('requires a session for every jobs route', async () => {
    for (const [method, url] of [['GET', '/api/jobs'], ['GET', '/api/jobs/summary'], ['GET', '/api/jobs/x']] as const) {
      expect((await server.inject({ method, url })).statusCode).toBe(401);
    }
    const anonymous = await server.inject({
      method: 'POST', url: '/api/jobs', headers: { origin: testAuth.origin, 'x-requested-with': 'XMLHttpRequest' },
      payload: { url: 'https://jobs.example.test/anon', title: 'T', company: 'C' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('saves a job rejected by a pipeline stage as rejected with its reason, even without a company', async () => {
    const result = await jobs.recordFound(ownerId, [
      { url: 'https://filter.example.test/1', source: 'filtertest', title: 'Java Developer', company: '', rejection: 'название: исключено «java»' },
      { url: 'https://filter.example.test/2', source: 'filtertest', title: 'Node Developer', company: '' },
    ]);
    expect(result).toMatchObject({ created: 1, invalid: 1 });
    const saved = await jobs.get({ id: ownerId, role: 'user' }, result.jobIds[0]!);
    expect(saved).toMatchObject({ status: 'rejected', why: 'название: исключено «java»', company: '' });
    expect((await jobs.changeStatus({ id: ownerId, role: 'user' }, saved.id, 'queued')).status).toBe('queued');

    const manual = await create(owner, { url: 'https://filter.example.test/3', title: 'X', company: 'Y', rejection: 'nope' });
    expect(manual.statusCode).toBe(400);
  });
});

describe('Jobs: scoring and Job-Tracker sync pipeline API on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let jobs: JobService;
  let ownerId: string;
  let strangerId: string;
  let urlCounter = 0;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    jobs = new JobService(new JobRepository(database));
    const user = (email: string) => database.user.create({ data: { email, name: email, passwordHash: 'unused' } });
    ownerId = (await user('scoring-owner@example.test')).id;
    strangerId = (await user('scoring-stranger@example.test')).id;
  }, 60_000);

  afterAll(async () => {
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  /** Saves one listing and returns its ID; each call gets a new URL. */
  async function found(userId: string, card: Partial<JobInput> = {}): Promise<string> {
    const result = await jobs.recordFound(userId, [{
      url: `https://pipeline.example.test/${++urlCounter}`, source: 'board', title: 'Developer', company: 'Acme',
      description: 'Text', ...card,
    }]);
    expect(result.created).toBe(1);
    return result.jobIds[0]!;
  }
  const missing = { code: 'JOB_NOT_FOUND', statusCode: 404 };

  it('lists found jobs with a description for scoring, oldest first, only for the owner', async () => {
    const first = await found(ownerId, { title: 'First' });
    await found(ownerId, { title: 'No description', description: null });
    const third = await found(ownerId, { title: 'Third' });
    const scored = await found(ownerId, { title: 'Scored' });
    await jobs.recordScore(ownerId, scored, { score: 50 });
    await found(strangerId, { title: 'Stranger' });

    const batch = await jobs.listForScoring(ownerId);
    expect(batch.map((job) => job.id)).toEqual([first, third]);
    expect(batch[0]).toMatchObject({ title: 'First', description: 'Text', status: 'found', trackerId: null, profileRevision: null });
    expect((await jobs.listForScoring(ownerId, 1)).map((job) => job.id)).toEqual([first]);
    expect((await jobs.listForScoring(strangerId)).map((job) => job.title)).toEqual(['Stranger']);
    await expect(jobs.listForScoring(ownerId, 0)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('stores the profile revision with the score', async () => {
    const id = await found(ownerId);
    expect(await jobs.recordScore(ownerId, id, { score: 70, why: 'fits', profileRevision: 3 }))
      .toMatchObject({ status: 'scored', score: 70, why: 'fits', profileRevision: 3 });
    await expect(jobs.recordScore(ownerId, id, { score: 70, profileRevision: 1.5 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(jobs.recordScore(strangerId, id, { score: 10, profileRevision: 1 })).rejects.toMatchObject(missing);
  });

  it('finds a twin by company and title regardless of case, spacing and punctuation', async () => {
    const original = await found(ownerId, { company: 'Рога и Копыта, ООО', title: 'Senior  Vue.js Developer' });
    await jobs.recordScore(ownerId, original, { score: 80 });
    const repeat = await found(ownerId, { company: 'рога и копыта ооо', title: 'senior vue js developer' });

    expect(await jobs.findTwin(ownerId, 'рога и копыта ооо', 'senior vue js developer', repeat)).toMatchObject({ id: original, status: 'scored' });
    expect(await jobs.findTwin(ownerId, 'Рога и Копыта, ООО', 'Senior  Vue.js Developer', original)).toBeNull();
    expect(await jobs.findTwin(ownerId, 'Рога и Копыта', 'Senior Vue.js Developer', repeat)).toBeNull();
    expect(await jobs.findTwin(strangerId, 'рога и копыта ооо', 'senior vue js developer', repeat)).toBeNull();
  });

  it('counts as a twin only a job past scoring, rejected by the model or already sent to Job-Tracker', async () => {
    const twin = (title: string, exceptId: string) => jobs.findTwin(ownerId, 'Twin Co', title, exceptId);
    const probe = await found(ownerId, { company: 'Other', title: 'Probe' });

    await found(ownerId, { company: 'Twin Co', title: 'Found' });
    expect(await twin('Found', probe)).toBeNull();
    const rejected = await found(ownerId, { company: 'Twin Co', title: 'Rejected' });
    await jobs.recordDecision(ownerId, rejected, 'rejected');
    expect(await twin('Rejected', probe)).toBeNull();
    await found(ownerId, { company: 'Twin Co', title: 'Filtered', rejection: 'title filter' });
    expect(await twin('Filtered', probe)).toBeNull();
    const modelRejected = await found(ownerId, { company: 'Twin Co', title: 'Model Rejected' });
    await jobs.recordScore(ownerId, modelRejected, { score: 20, why: 'weak match' });
    await jobs.recordDecision(ownerId, modelRejected, 'rejected');
    expect(await twin('Model Rejected', probe)).toMatchObject({ id: modelRejected, status: 'rejected', score: 20 });

    const queued = await found(ownerId, { company: 'Twin Co', title: 'Queued' });
    await jobs.recordDecision(ownerId, queued, 'queued');
    expect(await twin('Queued', probe)).toMatchObject({ id: queued });

    const applying = await found(ownerId, { company: 'Twin Co', title: 'Applying' });
    await jobs.recordDecision(ownerId, applying, 'queued');
    await jobs.recordStatus(ownerId, applying, 'applying');
    expect(await twin('Applying', probe)).toMatchObject({ id: applying });

    const syncedThenSkipped = await found(ownerId, { company: 'Twin Co', title: 'Synced' });
    await jobs.recordDecision(ownerId, syncedThenSkipped, 'queued');
    await jobs.markSynced(ownerId, syncedThenSkipped, 'jt-twin');
    await jobs.recordDecision(ownerId, syncedThenSkipped, 'skipped');
    expect(await twin('Synced', probe)).toMatchObject({ id: syncedThenSkipped, status: 'skipped', trackerId: 'jt-twin' });
  });

  it('records decisions through the status transitions and replaces the reason only when given', async () => {
    const id = await found(ownerId, { title: 'Decision' });
    await jobs.recordScore(ownerId, id, { score: 30, why: 'weak match' });
    expect(await jobs.recordDecision(ownerId, id, 'rejected')).toMatchObject({ status: 'rejected', why: 'weak match' });
    expect(await jobs.recordDecision(ownerId, id, 'skipped', ' repeat of another job ')).toMatchObject({ status: 'skipped', why: 'repeat of another job' });
    await expect(jobs.recordDecision(ownerId, id, 'rejected')).rejects.toMatchObject({ code: 'INVALID_JOB_STATUS', statusCode: 409 });
    await expect(jobs.recordDecision(ownerId, id, 'applied' as 'queued')).rejects.toMatchObject({ statusCode: 400 });
    await expect(jobs.recordDecision(strangerId, id, 'queued')).rejects.toMatchObject(missing);
    expect(await jobs.recordDecision(ownerId, id, 'queued', '')).toMatchObject({ status: 'queued', why: null });
  });

  it('reports 409 when another process changed the status first', async () => {
    const id = await found(ownerId, { title: 'Race' });
    await database.job.update({ where: { id }, data: { status: 'skipped' } });
    await expect(jobs.recordDecision(ownerId, id, 'rejected')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lists queued jobs not yet sent to Job-Tracker and remembers the tracker ID per owner', async () => {
    const before = new Set((await jobs.listUnsynced(ownerId)).map((job) => job.id));
    const first = await found(ownerId, { title: 'Sync first' });
    const second = await found(ownerId, { title: 'Sync second' });
    await found(ownerId, { title: 'Not queued' });
    const strangers = await found(strangerId, { title: 'Stranger queued' });
    for (const [userId, id] of [[ownerId, first], [ownerId, second], [strangerId, strangers]] as const) {
      await jobs.recordDecision(userId, id, 'queued');
    }

    const unsynced = (await jobs.listUnsynced(ownerId)).filter((job) => !before.has(job.id));
    expect(unsynced.map((job) => job.id)).toEqual([first, second]);
    expect((await jobs.listUnsynced(strangerId)).map((job) => job.id)).toEqual([strangers]);

    await expect(jobs.markSynced(strangerId, first, 'jt-1')).rejects.toMatchObject(missing);
    expect(await jobs.markSynced(ownerId, first, ' jt-1 ')).toMatchObject({ id: first, trackerId: 'jt-1', status: 'queued' });
    expect(await jobs.markSynced(ownerId, first, 'jt-1')).toMatchObject({ trackerId: 'jt-1' });
    await expect(jobs.markSynced(ownerId, first, 'jt-other')).rejects.toMatchObject({ code: 'JOB_ALREADY_SYNCED', statusCode: 409 });
    await expect(jobs.markSynced(ownerId, second, '  ')).rejects.toMatchObject({ statusCode: 400 });
    expect((await jobs.listUnsynced(ownerId)).filter((job) => !before.has(job.id)).map((job) => job.id)).toEqual([second]);
  });
});
