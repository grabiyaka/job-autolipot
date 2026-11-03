import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../plugins/database.js';
import { JobRepository } from '../src/jobs/JobRepository.js';
import { JobService } from '../src/jobs/JobService.js';
import type { Job, JobPage } from '../src/jobs/JobService.js';
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
