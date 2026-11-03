import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../plugins/database.js';
import { createHttpClient, HttpError, pause } from '../plugins/http.js';
import { JobRepository } from '../src/jobs/JobRepository.js';
import { JobService } from '../src/jobs/JobService.js';
import type { JobInput, JobPipelineApi } from '../src/jobs/JobTypes.js';
import { SearchRepository } from '../src/searches/SearchRepository.js';
import { SearchService } from '../src/searches/SearchService.js';
import { titleHas, titleRejection, titleTerms } from '../src/searches/SearchRules.js';
import type { SearchRuntime } from '../src/searches/SearchService.js';
import { BrowserError, BrowserUnavailableError, SourceStopError } from '../src/searches/SearchTypes.js';
import type { Browser, JobCard, JobSource, Logger } from '../src/searches/SearchTypes.js';
import { createAuthFixture, createTestDatabase, testAuth } from './auth-fixture.js';
import type { AuthHeaders } from './auth-fixture.js';

const card = (id: number, extra: Partial<JobCard> = {}): JobCard => ({
  url: `https://fake.example.test/jobs/${id}?utm_source=feed`, externalId: String(id), title: `Job ${id}`, company: 'Fake Co', ...extra,
});

type FakeOptions = Partial<Pick<JobSource, 'details'>> & { pages: JobCard[][]; failOnPage?: number; maxPages?: number };

/** A site with fixed result pages; it records how many pages were actually requested. */
function fakeSource(id: string, options: FakeOptions) {
  const requested: number[] = [];
  const source: JobSource = {
    id,
    title: `Fake ${id}`,
    limits: { pageDelayMs: [100, 200], maxPagesPerQuery: options.maxPages ?? 10 },
    async *search() {
      for (const [index, page] of options.pages.entries()) {
        requested.push(index + 1);
        if (options.failOnPage === index + 1) throw new Error('site changed its markup');
        yield page;
      }
    },
    canonicalUrl(url) {
      const parsed = new URL(url);
      parsed.search = '';
      return parsed.toString();
    },
    ...(options.details ? { details: options.details } : {}),
  };
  return { source, requested };
}

/** In-memory jobs keyed by owner, mirroring JobService semantics. */
function memoryJobs() {
  const saved = new Map<string, Map<string, JobInput>>();
  const owned = (ownerId: string) => saved.get(ownerId) ?? saved.set(ownerId, new Map()).get(ownerId)!;
  const jobs: JobPipelineApi = {
    async unknownUrls(ownerId, urls) { return urls.filter((url) => !owned(ownerId).has(url)); },
    async recordFound(ownerId, inputs) {
      const jobIds: string[] = [];
      for (const job of inputs) if (!owned(ownerId).has(job.url)) { owned(ownerId).set(job.url, job); jobIds.push(job.url); }
      return { created: jobIds.length, duplicates: inputs.length - jobIds.length, invalid: 0, jobIds };
    },
  };
  return { jobs, owned };
}

const silent: Logger = { info: () => {}, warn: () => {} };

/** A browser that is never expected to be used, except where a test replaces it. */
const noBrowser: Browser = {
  open: async () => { throw new BrowserError('unexpected browser call'); },
  currentPage: async () => null,
  text: async () => { throw new BrowserError('unexpected browser call'); },
  links: async () => { throw new BrowserError('unexpected browser call'); },
  scroll: async () => {},
};
const clock = { now: () => new Date('2026-11-03T10:00:00.000Z') };
const signal = () => new AbortController().signal;
const actor = (id: string) => ({ id, role: 'user' as const });

describe('title filter rules', () => {
  it('matches whole words and phrases, case-insensitively', () => {
    expect(titleHas('Senior Java Developer', 'java')).toBe(true);
    expect(titleHas('JavaScript Developer', 'java')).toBe(false);
    expect(titleHas('Backend Engineer (Node.js / TypeScript)', 'node')).toBe(true);
    expect(titleHas('Backend Engineer (Node.js / TypeScript)', 'node.js')).toBe(true);
    expect(titleHas('Senior C++ Engineer', 'c++')).toBe(true);
    expect(titleHas('Senior C Engineer', 'c++')).toBe(false);
    expect(titleHas('Senior QA Engineer - Remote', 'qa')).toBe(true);
    expect(titleHas('Aqa Lead', 'qa')).toBe(false);
    expect(titleHas('Senior  Full   Stack Engineer', 'full stack')).toBe(true);
    expect(titleHas('Programista aplikacji na Androida', 'android')).toBe(false);
  });

  it('rejects on any excluded word, requires one included word, and never judges an empty title', () => {
    const filter = { includeTitle: titleTerms(['Node', ' TypeScript ', 'node']), excludeTitle: titleTerms(['Java', 'QA']) };
    expect(filter.includeTitle).toEqual(['node', 'typescript']);
    expect(titleRejection('Senior Node.js Developer', filter)).toBeNull();
    expect(titleRejection('Senior QA Engineer (Node)', filter)).toBe('название: исключено «qa»');
    expect(titleRejection('Senior Ruby Engineer', filter)).toBe('название: нет ни одного из «node», «typescript»');
    expect(titleRejection('', filter)).toBeNull();
    expect(titleRejection('Anything', { includeTitle: [], excludeTitle: [] })).toBeNull();
    expect(titleRejection('Office Manager', { includeTitle: ['node', 'vue', 'react', 'go', 'php'], excludeTitle: [] }))
      .toBe('название: нет ни одного из «node», «vue», «react» и ещё 2');
    expect(() => titleTerms(Array.from({ length: 51 }, (_, index) => `w${index}`))).toThrow(/до 50 слов/);
  });
});

describe('Searches on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let repository: SearchRepository;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    repository = new SearchRepository(database);
    const user = (email: string) => database.user.create({ data: { email, name: email, passwordHash: 'unused' } });
    alice = (await user('alice@example.test')).id;
    bob = (await user('bob@example.test')).id;
  }, 60_000);

  afterAll(async () => {
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  function serviceWith(jobs: JobPipelineApi, sources: JobSource[], runtime: Partial<SearchRuntime> = {}, pauses: number[] = []) {
    return new SearchService(repository, jobs, sources, {
      http: createHttpClient({ userAgent: 'test', timeoutMs: 1000, retries: 0, pause }),
      browser: noBrowser,
      log: silent,
      pause: async (ms) => { pauses.push(ms); },
      random: () => 0.5,
      ...runtime,
    }, clock);
  }

  /** Saved searches run in creation order; a pause keeps creation times distinct (SQLite stores milliseconds). */
  async function createInOrder(service: SearchService, owner: string, inputs: Parameters<SearchService['create']>[1][]) {
    const created = [];
    for (const input of inputs) {
      created.push(await service.create(actor(owner), input));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return created;
  }

  async function freshOwner(): Promise<string> {
    const email = `owner-${Math.random().toString(36).slice(2)}@example.test`;
    return (await database.user.create({ data: { email, name: email, passwordHash: 'unused' } })).id;
  }

  describe('a run on a fake source', () => {
    const query = { source: 'fake', keywords: 'typescript' };

    it('records canonical cards, pauses between pages and repeats nothing on the next run', async () => {
      const { jobs, owned } = memoryJobs();
      const pauses: number[] = [];
      const { source, requested } = fakeSource('fake', { pages: [[card(1), card(2), card(1)], [card(3)]] });
      const service = serviceWith(jobs, [source], {}, pauses);

      const first = await service.runAdHoc('alice', query, { signal: signal() });
      expect(first).toMatchObject({ searchId: null, pages: 2, seen: 3, fresh: 3, created: 3, stopped: 'end' });
      expect([...owned('alice').keys()]).toEqual([1, 2, 3].map((id) => `https://fake.example.test/jobs/${id}`));
      expect(owned('alice').get('https://fake.example.test/jobs/1')).toMatchObject({ source: 'fake', externalId: '1' });
      expect(pauses).toEqual([150, 150]);

      requested.length = 0;
      const second = await service.runAdHoc('alice', query, { signal: signal() });
      expect(second).toMatchObject({ pages: 1, fresh: 0, created: 0, stopped: 'known' });
      expect(requested).toEqual([1]);
    });

    it('stops at the page limit of the source', async () => {
      const { source, requested } = fakeSource('fake', { pages: [[card(1)], [card(2)], [card(3)]], maxPages: 2 });
      const report = await serviceWith(memoryJobs().jobs, [source]).runAdHoc('alice', query, { signal: signal() });
      expect(report).toMatchObject({ pages: 2, created: 2, stopped: 'limit' });
      expect(requested).toEqual([1, 2]);
    });

    it('loads details only for new cards and keeps a card whose details fail', async () => {
      const { jobs } = memoryJobs();
      await jobs.recordFound('alice', [{ ...card(1), url: 'https://fake.example.test/jobs/1', source: 'fake' }]);
      const asked: string[] = [];
      const { source } = fakeSource('fake', {
        pages: [[card(1), card(2), card(3), card(4, { description: 'from list' })]],
        async details(_context, job) {
          asked.push(job.url);
          if (job.url.endsWith('/3')) throw new Error('timeout');
          return { description: `full ${job.title}` };
        },
      });
      const saved: JobInput[] = [];
      const recording: JobPipelineApi = { ...jobs, async recordFound(ownerId, inputs) { saved.push(...inputs); return jobs.recordFound(ownerId, inputs); } };

      const report = await serviceWith(recording, [source]).runAdHoc('alice', query, { signal: signal() });
      expect(report).toMatchObject({ fresh: 3, created: 3 });
      expect(asked).toEqual(['https://fake.example.test/jobs/2', 'https://fake.example.test/jobs/3']);
      expect(saved.map((job) => job.description)).toEqual(['full Job 2', undefined, 'from list']);
    });

    it('skips invalid URLs and writes nothing in dry-run', async () => {
      const { jobs, owned } = memoryJobs();
      const { source } = fakeSource('fake', { pages: [[card(1), { ...card(2), url: 'not a url' }]] });
      const dry = await serviceWith(jobs, [source]).runAdHoc('alice', query, { signal: signal(), dryRun: true });
      expect(dry).toMatchObject({ seen: 1, fresh: 1, created: 0, invalid: 1 });
      expect(owned('alice').size).toBe(0);
    });

    it('rejects an ad hoc search on a source that is not registered', async () => {
      await expect(serviceWith(memoryJobs().jobs, []).runAdHoc('alice', query, { signal: signal() }))
        .rejects.toMatchObject({ code: 'UNKNOWN_SEARCH_SOURCE' });
    });
  });

  describe('title filter in a run', () => {
    it('saves rejected titles without opening their pages, prints them in dry-run and stops on known next time', async () => {
      const jobs = new JobService(new JobRepository(database));
      const owner = await freshOwner();
      const opened: string[] = [];
      const { source } = fakeSource('fake', {
        pages: [[card(1, { title: 'Senior Node.js Engineer', company: '' }), card(2, { title: 'Java Developer', company: '' }), card(3, { title: 'Office Manager', company: '' })]],
        async details(_context, job) { opened.push(job.title); return { company: 'Acme', description: 'Full text' }; },
      });
      const lines: string[] = [];
      const service = serviceWith(jobs, [source], { log: { info: (line) => lines.push(line), warn: () => {} } });
      const input = { source: 'fake', keywords: 'node', includeTitle: ['node', 'typescript'], excludeTitle: ['java'] };

      const dry = await service.runAdHoc(owner, input, { signal: signal(), dryRun: true });
      expect(dry).toMatchObject({ fresh: 3, filtered: 2, created: 0 });
      expect(lines.filter((line) => line.startsWith('  '))).toEqual([
        '  − Java Developer (название: исключено «java») https://fake.example.test/jobs/2',
        '  − Office Manager (название: нет ни одного из «node», «typescript») https://fake.example.test/jobs/3',
        '  + Senior Node.js Engineer — Acme https://fake.example.test/jobs/1',
      ]);
      opened.length = 0;

      const report = await service.runAdHoc(owner, input, { signal: signal() });
      expect(report).toMatchObject({ fresh: 3, filtered: 2, created: 3, invalid: 0, stopped: 'end' });
      expect(opened).toEqual(['Senior Node.js Engineer']);
      const saved = (await jobs.list(actor(owner))).items.map((job) => [job.title, job.company, job.status, job.why]).sort();
      expect(saved).toEqual([
        ['Java Developer', '', 'rejected', 'название: исключено «java»'],
        ['Office Manager', '', 'rejected', 'название: нет ни одного из «node», «typescript»'],
        ['Senior Node.js Engineer', 'Acme', 'found', null],
      ]);

      expect(await service.runAdHoc(owner, input, { signal: signal() })).toMatchObject({ fresh: 0, created: 0, stopped: 'known' });
    });
  });

  describe('saved searches', () => {
    it('runs enabled searches in order, records each run and isolates a failing source', async () => {
      const owner = await freshOwner();
      const { jobs, owned } = memoryJobs();
      const broken = fakeSource('broken', { pages: [[card(1)], [card(2)]], failOnPage: 2 });
      const healthy = fakeSource('healthy', { pages: [[card(10)]] });
      const service = serviceWith(jobs, [broken.source, healthy.source]);
      const created = await createInOrder(service, owner, [
        { source: 'broken', keywords: ' node ' },
        { source: 'healthy', keywords: 'vue', location: 'Europe' },
        { source: 'healthy', keywords: 'off', enabled: false },
      ]);
      const first = created[0]!;
      const second = created[1]!;

      const reports = await service.runSaved({ ownerId: owner, signal: signal() });
      expect(reports.map((report) => [report.searchId, report.source, report.created, report.stopped])).toEqual([
        [first.id, 'broken', 1, 'error'],
        [second.id, 'healthy', 1, 'end'],
      ]);
      expect(reports[0]!.error).toBe('site changed its markup');
      expect(reports[1]!.query).toEqual({ keywords: 'vue', location: 'Europe' });
      expect(owned(owner).size).toBe(2);

      expect(await service.runs(actor(owner), first.id)).toMatchObject([{
        pages: 1, created: 1, stopped: 'error', error: 'site changed its markup',
        startedAt: '2026-11-03T10:00:00.000Z', finishedAt: '2026-11-03T10:00:00.000Z',
      }]);
      await service.runSaved({ ownerId: owner, signal: signal(), dryRun: true });
      expect(await service.runs(actor(owner), second.id)).toHaveLength(1);
    });

    it('stops between searches on abort and reports a search whose source was removed', async () => {
      const owner = await freshOwner();
      const controller = new AbortController();
      const endless = fakeSource('endless', { pages: [[card(1)], [card(2)], [card(3)]] });
      const next = fakeSource('next', { pages: [[card(9)]] });
      const setup = serviceWith(memoryJobs().jobs, [endless.source, next.source]);
      await createInOrder(setup, owner, [{ source: 'endless', keywords: 'a' }, { source: 'next', keywords: 'b' }]);

      const aborting = serviceWith(memoryJobs().jobs, [endless.source, next.source], {
        random: () => 0, pause: async (_ms, runSignal) => { controller.abort(); runSignal.throwIfAborted(); },
      });
      const reports = await aborting.runSaved({ ownerId: owner, signal: controller.signal });
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ source: 'endless', pages: 1, created: 1, stopped: 'aborted' });
      expect(endless.requested).toEqual([1]);

      const withoutNext = serviceWith(memoryJobs().jobs, [endless.source]);
      const later = await withoutNext.runSaved({ ownerId: owner, signal: signal(), dryRun: true });
      expect(later.map((report) => [report.source, report.stopped])).toEqual([['endless', 'end'], ['next', 'error']]);
    });

    it('gives modules the run-bound browser and stops the run when the browser is unreachable', async () => {
      const owner = await freshOwner();
      const seenSignals: (AbortSignal | undefined)[] = [];
      const browser: Browser = { ...noBrowser, async open(url, signal) {
        seenSignals.push(signal);
        if (url.includes('down')) throw new BrowserUnavailableError('browser broker is not running');
        return { url, title: 'Page', status: 200 };
      } };
      const browsing = (id: string, url: string): JobSource => ({
        ...fakeSource(id, { pages: [] }).source,
        async *search(context) {
          const page = await context.browser.open(url);
          yield [card(1, { title: page.title })];
        },
      });
      const service = serviceWith(memoryJobs().jobs, [browsing('up', 'https://up.test/'), browsing('down', 'https://down.test/'), fakeSource('after', { pages: [[card(5)]] }).source], { browser });
      await createInOrder(service, owner, ['up', 'down', 'after'].map((source) => ({ source, keywords: 'k' })));

      const run = new AbortController();
      const reports = await service.runSaved({ ownerId: owner, signal: run.signal });
      expect(reports.map((report) => [report.source, report.stopped, report.created])).toEqual([['up', 'end', 1], ['down', 'error', 0]]);
      expect(reports[1]!.error).toBe('browser broker is not running');
      expect(seenSignals).toEqual([run.signal, run.signal]);
    });

    it('skips the other searches of a source that hit a sign-in wall and merges job page details', async () => {
      const owner = await freshOwner();
      const { jobs, owned } = memoryJobs();
      let walled = false;
      const site: JobSource = {
        ...fakeSource('site', { pages: [] }).source,
        async *search(_context, query) {
          if (query.keywords === 'walled') { walled = true; throw new SourceStopError('login required'); }
          yield [{ url: `https://site.test/jobs/${query.keywords}`, title: 'From list', company: '' }];
        },
        async details(context) {
          await context.pause(10);
          if (walled) throw new SourceStopError('login required');
          return { company: 'Acme', description: 'Full text', location: 'Remote' };
        },
      };
      const other = fakeSource('other', { pages: [[card(3)]] });
      const pauses: number[] = [];
      const service = serviceWith(jobs, [site, other.source], {}, pauses);
      await createInOrder(service, owner, [
        { source: 'site', keywords: 'first' }, { source: 'site', keywords: 'walled' },
        { source: 'site', keywords: 'skipped' }, { source: 'other', keywords: 'still runs' },
      ]);

      const reports = await service.runSaved({ ownerId: owner, signal: signal() });
      expect(reports.map((report) => [report.query.keywords, report.stopped, report.created])).toEqual([
        ['first', 'end', 1], ['walled', 'error', 0], ['skipped', 'error', 0], ['still runs', 'end', 1],
      ]);
      expect(reports[2]!.error).toBe('пропущен: login required');
      expect(owned(owner).get('https://site.test/jobs/first')).toMatchObject({ title: 'From list', company: 'Acme', description: 'Full text', location: 'Remote' });
      expect(pauses).toContain(10);
    });

    it('gives each owner their own jobs through JobService and never duplicates on repeated runs', async () => {
      const jobs = new JobService(new JobRepository(database));
      const { source } = fakeSource('fake', { pages: [[card(1), card(2)]] });
      const service = serviceWith(jobs, [source]);
      for (const owner of [alice, bob]) await service.create(actor(owner), { source: 'fake', keywords: 'typescript' });

      const first = await Promise.all([alice, bob].map((ownerId) => service.runSaved({ ownerId, signal: signal() })));
      expect(first.flat().map((report) => report.created)).toEqual([2, 2]);
      const second = await service.runSaved({ ownerId: alice, signal: signal() });
      expect(second.map((report) => [report.created, report.stopped])).toEqual([[0, 'known']]);

      const aliceJobs = await jobs.list(actor(alice));
      expect(aliceJobs.items.map((job) => [job.url, job.source, job.status]).sort()).toEqual([
        ['https://fake.example.test/jobs/1', 'fake', 'found'],
        ['https://fake.example.test/jobs/2', 'fake', 'found'],
      ]);
      expect((await jobs.list(actor(bob))).total).toBe(2);
    });
  });
});

describe('Searches HTTP API', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let owner: AuthHeaders;
  let stranger: AuthHeaders;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    server = await buildServer({ databaseUrl: testDatabase.url, logger: false, auth: testAuth });
    const auth = await createAuthFixture(server, database);
    owner = auth.userHeaders;
    stranger = auth.adminHeaders;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  it('lists sources, rejects unknown ones and hides other owners\' searches', async () => {
    const sources = await server.inject({ method: 'GET', url: '/api/searches/sources', headers: owner });
    expect(sources.statusCode).toBe(200);
    expect(sources.json()).toEqual([{ id: 'linkedin', title: 'LinkedIn' }]);

    const created = await server.inject({ method: 'POST', url: '/api/searches', headers: owner, payload: { source: 'nowhere', keywords: 'node' } });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({ error: { code: 'UNKNOWN_SEARCH_SOURCE' } });

    expect((await server.inject({ method: 'GET', url: '/api/searches', headers: stranger })).json()).toEqual([]);
    const missing = await server.inject({ method: 'PATCH', url: '/api/searches/missing', headers: owner, payload: { enabled: false } });
    expect(missing.statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/api/searches' })).statusCode).toBe(401);
  });

  it('stores title filters of a saved search and lets the owner change or clear them', async () => {
    const created = await server.inject({
      method: 'POST', url: '/api/searches', headers: owner,
      payload: { source: 'linkedin', keywords: 'node.js', location: 'Remote', includeTitle: ['Node', 'TypeScript'], excludeTitle: ['Java', ' QA '] },
    });
    expect(created.statusCode).toBe(201);
    const search = created.json() as { id: string; includeTitle: string[]; excludeTitle: string[] };
    expect([search.includeTitle, search.excludeTitle]).toEqual([['node', 'typescript'], ['java', 'qa']]);

    const changed = await server.inject({ method: 'PATCH', url: `/api/searches/${search.id}`, headers: owner, payload: { includeTitle: [], excludeTitle: ['android'] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ keywords: 'node.js', location: 'Remote', includeTitle: [], excludeTitle: ['android'] });

    const tooLong = await server.inject({ method: 'PATCH', url: `/api/searches/${search.id}`, headers: owner, payload: { excludeTitle: ['x'.repeat(61)] } });
    expect(tooLong.statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: `/api/searches/${search.id}/runs`, headers: owner })).json()).toEqual([]);
  });
});

describe('HTTP client plugin', () => {
  it('retries 5xx with growing pauses, sends the User-Agent and does not retry 404', async () => {
    const statuses = [503, 200];
    const agents: string[] = [];
    const server = createServer((request, response) => {
      agents.push(request.headers['user-agent'] ?? '');
      if (request.url === '/missing') { response.writeHead(404).end(); return; }
      response.writeHead(statuses.shift() ?? 200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pauses: number[] = [];
    const http = createHttpClient({ userAgent: 'collector-test', timeoutMs: 2000, retries: 2, pause: async (ms) => { pauses.push(ms); } });
    try {
      expect(await http.json<{ ok: boolean }>(`${base}/list`)).toEqual({ ok: true });
      expect(pauses).toEqual([1000]);
      await expect(http.text(`${base}/missing`)).rejects.toBeInstanceOf(HttpError);
      expect(pauses).toEqual([1000]);
      expect(agents.every((agent) => agent === 'collector-test')).toBe(true);
    } finally { server.close(); }
  });
});
