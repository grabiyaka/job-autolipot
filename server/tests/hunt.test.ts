import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { browseDisallowedTools, browseTools, denyReasons, guardDecision, initialGuardState, parseApplyMode } from '../plugins/agent-guard-rules.js';
import type { GuardContext } from '../plugins/agent-guard-rules.js';
import { parseTabs } from '../plugins/browser-tabs.js';
import { createPrismaClient } from '../plugins/database.js';
import { huntAgentConfigFromEnv, huntSettingsFromEnv } from '../plugins/environment.js';
import { adHocHunt, huntLimit, huntReportLine } from '../scripts/pipeline-cli.js';
import { JobRepository } from '../src/jobs/JobRepository.js';
import { JobService } from '../src/jobs/JobService.js';
import { agentSiteLabel, agentSites, resolveAgentSite } from '../src/searches/AgentSites.js';
import { HuntAgentError } from '../src/searches/HuntContracts.js';
import type { HuntAgent, HuntAgentRequest, HuntTabs } from '../src/searches/HuntContracts.js';
import { describedCards, listedCards, parsePostedAt, tabsToClose } from '../src/searches/HuntRules.js';
import type { HuntTab } from '../src/searches/HuntRules.js';
import { HuntService } from '../src/searches/HuntService.js';
import type { HuntReport } from '../src/searches/HuntService.js';
import { SearchRepository } from '../src/searches/SearchRepository.js';
import { SearchService } from '../src/searches/SearchService.js';
import type { Browser, Logger } from '../src/searches/SearchTypes.js';
import { createTestDatabase } from './auth-fixture.js';

const site = (id: string) => resolveAgentSite(id);
const now = new Date('2026-11-09T12:00:00.000Z');

describe('agent sites', () => {
  it('builds search URLs: Indeed on ie or www by location with a second page, Djinni, Remote OK tags, Wellfound roles', () => {
    expect(site('indeed').searchUrls({ keywords: 'node.js', location: 'Dublin, Ireland' })).toEqual([
      'https://ie.indeed.com/jobs?q=node.js&l=Dublin%2C+Ireland', 'https://ie.indeed.com/jobs?q=node.js&l=Dublin%2C+Ireland&start=10',
    ]);
    expect(site('indeed').searchUrls({ keywords: 'node developer', location: 'Remote' })[0]).toBe('https://www.indeed.com/jobs?q=node+developer&l=Remote');
    expect(site('indeed').searchUrls({ keywords: 'node' })[0]).toBe('https://www.indeed.com/jobs?q=node&l=');
    expect(site('djinni').searchUrls({ keywords: 'node.js' })).toEqual([
      'https://djinni.co/jobs/?all_keywords=node.js&remote_type=full_remote', 'https://djinni.co/jobs/?all_keywords=node.js&remote_type=full_remote&page=2',
    ]);
    expect(site('remoteok').searchUrls({ keywords: 'Node.js' })).toEqual(['https://remoteok.com/remote-node-jobs']);
    expect(site('remoteok').searchUrls({ keywords: 'react native' })).toEqual(['https://remoteok.com/remote-react-native-jobs']);
    expect(site('wellfound').searchUrls({ keywords: 'Node.js Developer', location: 'Remote' })[0]).toBe('https://wellfound.com/role/r/node-js-developer');
    expect(site('wellfound').searchUrls({ keywords: 'software engineer', location: 'Dublin' })).toEqual([
      'https://wellfound.com/role/l/software-engineer/dublin', 'https://wellfound.com/role/l/software-engineer/dublin?page=2',
    ]);
  });

  it('canonicalizes job URLs per site and rejects other hosts and non-job pages', () => {
    const indeed = site('indeed');
    expect(indeed.canonical('https://ie.indeed.com/viewjob?jk=B11AC301830311FD&from=serp&tk=1x')).toEqual({ url: 'https://ie.indeed.com/viewjob?jk=b11ac301830311fd', externalId: 'b11ac301830311fd' });
    expect(indeed.canonical('https://www.indeed.com/jobs?q=node&vjk=332571a801bf5bda').url).toBe('https://www.indeed.com/viewjob?jk=332571a801bf5bda');
    expect(indeed.canonical('https://ie.indeed.com/career/salaries?fromjk=6c43c2936fd56a1f').url).toBe('https://ie.indeed.com/viewjob?jk=6c43c2936fd56a1f');
    expect(() => indeed.canonical('https://ie.indeed.com/viewjob?jk=123')).toThrow('jk');
    expect(() => indeed.canonical('https://evil.example/viewjob?jk=b11ac301830311fd')).toThrow('чужой сайт');
    expect(() => indeed.canonical('https://uk.indeed.com/viewjob?jk=b11ac301830311fd')).toThrow('чужой сайт');

    expect(site('djinni').canonical('https://djinni.co/jobs/856827-middle-senior-node-js-developer/?from=list#apply')).toEqual({ url: 'https://djinni.co/jobs/856827-middle-senior-node-js-developer/', externalId: '856827' });
    expect(() => site('djinni').canonical('https://djinni.co/jobs/?all_keywords=node')).toThrow('Djinni');
    expect(site('remoteok').canonical('https://remoteok.com/remote-jobs/remote-senior-backend-engineer-duckduckgo-1137551?ref=x')).toEqual({ url: 'https://remoteok.com/remote-jobs/remote-senior-backend-engineer-duckduckgo-1137551', externalId: '1137551' });
    expect(() => site('remoteok').canonical('https://remoteok.com/l/1137551')).toThrow('Remote OK');
    expect(site('wellfound').canonical('https://wellfound.com/company/acme/jobs/4105635-full-stack-developer')).toEqual({ url: 'https://wellfound.com/jobs/4105635-full-stack-developer', externalId: '4105635' });

    const generic = site('https://jobs.example.test/search?q={q}');
    expect(generic).toMatchObject({ id: 'jobs.example.test', hosts: ['jobs.example.test'], generic: true });
    expect(generic.searchUrls({ keywords: 'node.js dev' })).toEqual(['https://jobs.example.test/search?q=node.js%20dev']);
    expect(generic.canonical('https://jobs.example.test/job/7?utm_source=x&ref=feed&id=7#top')).toEqual({ url: 'https://jobs.example.test/job/7?id=7' });
    expect(() => generic.canonical('https://other.example.test/job/7')).toThrow('чужой сайт');
  });

  it('resolves the saved site: known ids, https addresses and bare hosts; refuses the rest', () => {
    expect(resolveAgentSite('Indeed').key).toBe('indeed');
    expect(resolveAgentSite('www.welcometothejungle.com').key).toBe('https://www.welcometothejungle.com/');
    expect(resolveAgentSite('https://ie.indeed.com/jobs?q=node#x')).toMatchObject({ id: 'indeed', key: 'https://ie.indeed.com/jobs?q=node' });
    for (const bad of ['', 'http://jobs.example.test/', 'nowhere', 'ftp://jobs.example.test/', 'https://user:pw@jobs.example.test/']) {
      expect(() => resolveAgentSite(bad), bad).toThrow(/не распознан/);
    }
    expect(agentSites.map((known) => known.id)).toEqual(['indeed', 'djinni', 'remoteok', 'wellfound']);
    expect([agentSiteLabel('indeed'), agentSiteLabel('https://www.jobs.example.test/x'), agentSiteLabel(null)]).toEqual(['indeed', 'jobs.example.test', 'agent']);
  });

  it('parses simple relative posting dates and leaves anything else empty', () => {
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    expect(parsePostedAt('4d', now)).toEqual(daysAgo(4));
    expect(parsePostedAt('19d', now)).toEqual(daysAgo(19));
    expect(parsePostedAt('1mo', now)).toEqual(daysAgo(30));
    expect(parsePostedAt('4 days ago', now)).toEqual(daysAgo(4));
    expect(parsePostedAt('updated 4d ago', now)).toEqual(daysAgo(4));
    expect(parsePostedAt('Posted 30+ days ago', now)).toEqual(daysAgo(30));
    expect(parsePostedAt('an hour ago', now)).toEqual(new Date(now.getTime() - 3_600_000));
    expect(parsePostedAt('2 weeks ago', now)).toEqual(daysAgo(14));
    expect(parsePostedAt('Today', now)).toEqual(now);
    expect(parsePostedAt('yesterday', now)).toEqual(daysAgo(1));
    expect(parsePostedAt('2026-11-01', now)).toEqual(new Date('2026-11-01T00:00:00Z'));
    for (const unknown of [null, '', 'recently', 'Nov 3', '4 fortnights ago', '2027-01-01']) expect(parsePostedAt(unknown, now), String(unknown)).toBeNull();
  });

  it('turns listed jobs into cards and descriptions into complete jobs', () => {
    const djinni = site('djinni');
    const { cards, invalid } = listedCards(djinni, [
      { url: 'https://djinni.co/jobs/1-node/', title: 'Node dev', company: 'A', location: 'Remote', postedAt: '4d' },
      { url: 'https://djinni.co/jobs/1-node/?ref=x', title: 'Node dev (again)', company: 'A', location: null, postedAt: null },
      { url: 'https://evil.example/jobs/2-x/', title: 'Off-site', company: 'B', location: null, postedAt: null },
      { url: 'https://djinni.co/jobs/3-ts/', title: 'TS dev', company: 'C', location: null, postedAt: 'recently' },
    ], now);
    expect(invalid).toBe(1);
    expect(cards).toEqual([
      { url: 'https://djinni.co/jobs/1-node/', title: 'Node dev', company: 'A', externalId: '1', location: 'Remote', postedAt: new Date(now.getTime() - 4 * 86_400_000), raw: { via: 'agent', site: 'djinni', postedAtText: '4d' } },
      { url: 'https://djinni.co/jobs/3-ts/', title: 'TS dev', company: 'C', externalId: '3', raw: { via: 'agent', site: 'djinni', postedAtText: 'recently' } },
    ]);
    const long = 'Node.js role. '.repeat(400);
    const described = describedCards(djinni, cards, [
      { url: 'https://djinni.co/jobs/1-node/?utm_source=x', description: `  ${long}\r\n\r\n\r\nend  `, company: null, location: null },
      { url: 'https://djinni.co/jobs/3-ts/', description: 'Closed.', company: null, location: null },
      { url: 'https://djinni.co/jobs/99-other/', description: long, company: null, location: null },
    ]);
    expect(described).toHaveLength(1);
    expect(described[0]!.description).toHaveLength(4000);
    expect(described[0]!.description!.startsWith('Node.js role.')).toBe(true);
  });

  it('closes only the tabs the agent opened on the site or left blank', () => {
    const before: HuntTab[] = [{ id: 'A', url: 'https://www.linkedin.com/jobs/' }];
    const after: HuntTab[] = [...before, { id: 'B', url: 'https://djinni.co/jobs/1/' }, { id: 'C', url: 'about:blank' }, { id: 'D', url: 'https://mail.example.test/' }];
    expect(tabsToClose(before, after, site('djinni').hosts)).toEqual(['B', 'C']);
    expect(parseTabs('### Result\n[{"id":"B","url":"https://djinni.co/"},{"id":7}]\n\n### Ran Playwright code\n```js\n```')).toEqual([{ id: 'B', url: 'https://djinni.co/' }]);
  });
});

describe('guard: browse mode of the collector agent', () => {
  const pw = (name: string) => `mcp__playwright__${name}`;
  const refs = {
    e1: { role: 'button', name: 'Reject all', text: '' },
    e2: { role: 'button', name: 'Apply now', text: '' },
    e3: { role: 'link', name: 'Sign in', text: '' },
    e4: { role: 'link', name: 'Senior Node.js Developer', text: 'Senior Node.js Developer Acme Easily apply' },
    e5: { role: 'searchbox', name: 'Job title, keywords, or company', text: '' },
    e6: { role: 'textbox', name: 'Email address', text: '' },
    e7: { role: 'button', name: '', text: 'Log in to see all jobs' },
    e8: { role: 'link', name: 'Next page', text: '' },
    e9: { role: 'button', name: 'Save job', text: '' },
    e10: { role: 'textbox', name: 'Where', text: '' },
  };
  const context: GuardContext = {
    uploadDir: null, refs, page: 'https://djinni.co/jobs/', startHost: null, visitedHosts: ['evil.example'], allowedHosts: ['djinni.co', 'www.djinni.co'],
  };
  const decide = (tool: string, args: unknown, own: Partial<GuardContext> = {}) => {
    const decision = guardDecision('browse', tool, args, initialGuardState, { ...context, ...own });
    return decision.allow ? 'allow' : decision.reason;
  };

  it('allows reading the board and denies leaving it', () => {
    expect(parseApplyMode('browse')).toBe('browse');
    expect(decide('StructuredOutput', { accessible: true, jobs: [] })).toBe('allow');
    expect(decide(pw('browser_snapshot'), { target: '#jobsboard' })).toBe('allow');
    expect(decide(pw('browser_navigate'), { url: 'https://djinni.co/jobs/1-node/' })).toBe('allow');
    expect(decide(pw('browser_navigate'), { url: 'https://evil.example/' })).toBe(denyReasons.browseSite);
    expect(decide(pw('browser_navigate'), { url: 'http://djinni.co/jobs/' })).toBe(denyReasons.browseSite);
    expect(decide(pw('browser_navigate'), { url: 'https://djinni.co/' }, { allowedHosts: [] })).toBe(denyReasons.browseSite);
    expect(decide(pw('browser_tabs'), { action: 'new' })).toBe('allow');
    expect(decide(pw('browser_tabs'), { action: 'new', url: 'https://djinni.co/jobs/' })).toBe('allow');
    expect(decide(pw('browser_tabs'), { action: 'new', url: 'https://evil.example/' })).toBe(denyReasons.browseSite);
    expect(decide(pw('browser_tabs'), { action: 'list' })).toBe('allow');
    expect(decide(pw('browser_tabs'), { action: 'close', index: 0 })).toBe(denyReasons.browseTabs);
    expect(decide(pw('browser_tabs'), { action: 'select', index: 1 })).toBe(denyReasons.browseTabs);
    expect(decide(pw('browser_navigate_back'), {})).toBe('allow');
    // After a click led away from the board, nothing there is read or clicked; going back is allowed.
    expect(decide(pw('browser_snapshot'), {}, { page: 'https://evil.example/login' })).toBe(denyReasons.browseOffSite);
    expect(decide(pw('browser_click'), { ref: 'e1' }, { page: 'https://evil.example/login' })).toBe(denyReasons.browseOffSite);
    expect(decide(pw('browser_snapshot'), {}, { page: 'about:blank' })).toBe('allow');
  });

  it('denies applying, accounts and saving; allows cookie banners, cards and pagination', () => {
    expect(decide(pw('browser_click'), { ref: 'e1', element: 'Reject all cookies' })).toBe('allow');
    expect(decide(pw('browser_click'), { ref: 'e4', element: 'job card' })).toBe('allow');
    expect(decide(pw('browser_click'), { ref: 'e8', element: 'Next page' })).toBe('allow');
    expect(decide(pw('browser_click'), { ref: 'e2', element: 'button' })).toBe(denyReasons.browseOnly);
    expect(decide(pw('browser_click'), { ref: 'e3', element: 'link' })).toBe(denyReasons.browseOnly);
    expect(decide(pw('browser_click'), { ref: 'e7', element: 'button' })).toBe(denyReasons.browseOnly);
    expect(decide(pw('browser_click'), { ref: 'e9', element: 'bookmark' })).toBe(denyReasons.browseOnly);
    expect(decide(pw('browser_click'), { ref: 'e8', element: 'Sign up for alerts' })).toBe(denyReasons.browseOnly);
    expect(decide(pw('browser_click'), { ref: 'e99' })).toBe(denyReasons.unknownRef);
  });

  it('types only into a search field, never submits, and has no Enter', () => {
    expect(decide(pw('browser_type'), { ref: 'e5', text: 'node.js' })).toBe('allow');
    expect(decide(pw('browser_type'), { ref: 'e10', text: 'Dublin', element: 'location' })).toBe('allow');
    expect(decide(pw('browser_type'), { ref: 'e5', text: 'node.js', submit: true })).toBe(denyReasons.browseTypeSubmit);
    expect(decide(pw('browser_type'), { ref: 'e6', text: 'me@example.test', element: 'search' })).toBe(denyReasons.browseTypeField);
    expect(decide(pw('browser_press_key'), { key: 'Enter' })).toBe(denyReasons.browseEnter);
    expect(decide(pw('browser_press_key'), { key: 'Escape' })).toBe('allow');
    for (const tool of ['browser_evaluate', 'browser_fill_form', 'browser_file_upload', 'browser_select_option', 'browser_close', 'browser_take_screenshot', 'browser_find']) {
      expect(decide(pw(tool), {}), tool).toBe(denyReasons.notAllowed);
      expect(browseDisallowedTools).toContain(pw(tool));
    }
    for (const tool of ['Bash', 'Read', 'WebFetch']) expect(decide(tool, {})).toBe(denyReasons.notAllowed);
    expect(browseTools).not.toContain(pw('browser_fill_form'));
  });
});

describe('hunt settings and CLI flags', () => {
  it('runs on the Claude account with HUNT_MODEL and HUNT_TIMEOUT_MS; the daily limit defaults to $5', () => {
    expect(huntAgentConfigFromEnv({})).toMatchObject({ settingsPath: null, model: 'sonnet', timeoutMs: 480_000, prices: null });
    expect(huntAgentConfigFromEnv({ HUNT_MODEL: 'opus', HUNT_TIMEOUT_MS: '1000', APPLY_AGENT: 'deepseek' })).toMatchObject({ settingsPath: null, model: 'opus', timeoutMs: 1000 });
    expect(() => huntAgentConfigFromEnv({ HUNT_TIMEOUT_MS: '0' })).toThrow('HUNT_TIMEOUT_MS');
    expect(huntSettingsFromEnv({}).maxUsdPerDay).toBe(5);
    expect(huntSettingsFromEnv({ HUNT_MAX_USD_PER_DAY: '1.5' }).maxUsdPerDay).toBe(1.5);
    expect(() => huntSettingsFromEnv({ HUNT_MAX_USD_PER_DAY: '-1' })).toThrow('HUNT_MAX_USD_PER_DAY');
  });

  it('parses an ad hoc agent search and the description limit', () => {
    expect(adHocHunt({})).toBeNull();
    expect(adHocHunt({ user: 'me@example.test', site: 'djinni', query: 'node.js', exclude: 'java, qa' })).toEqual({
      source: 'agent', site: 'djinni', keywords: 'node.js', location: null, includeTitle: null, excludeTitle: ['java', 'qa'],
    });
    expect(() => adHocHunt({ site: 'djinni', query: 'node' })).toThrow('--user');
    expect(huntLimit('3')).toBe(3);
    expect(() => huntLimit('51')).toThrow('--limit');
  });

  it('writes one line per search', () => {
    const report: HuntReport = {
      searchId: 's', ownerId: 'u', source: 'indeed', site: 'indeed', query: { keywords: 'node.js' }, pages: 1, seen: 20, fresh: 8,
      filtered: 3, created: 8, duplicates: 0, invalid: 0, stopped: 'end', described: 5, costMicros: 400_000, durationMs: 180_000, blocked: null, skipped: false,
    };
    expect(huntReportLine(report, false)).toBe('indeed «node.js»: карточек 20, новых 8, с описанием 5, отсеяно по названию 3, 3 мин, $0.40; записано 8');
    expect(huntReportLine({ ...report, stopped: 'limit' }, true)).toBe('indeed «node.js»: карточек 20, новых 8, с описанием 5, отсеяно по названию 3, 3 мин, $0.40; не записано (--dry-run); остальные новые — в следующий прогон (limit)');
    expect(huntReportLine({ ...report, skipped: true, blocked: 'captcha' }, false)).toBe('indeed: нужна капча/вход — пропущено');
    expect(huntReportLine({ ...report, site: 'https://jobs.example.test/', stopped: 'error', error: 'таймаут' }, false)).toMatch(/^jobs\.example\.test «node\.js»: .*; ошибка — таймаут$/);
  });
});

// ── The runner on SQLite with a fake agent ──

type Answer = unknown | ((request: HuntAgentRequest) => unknown);

/** An agent that answers from a queue: an object is the structured output, an Error is thrown. */
class FakeHuntAgent implements HuntAgent {
  requests: HuntAgentRequest[] = [];
  constructor(private readonly answers: Answer[], private readonly cost = 100_000) {}
  async run(request: HuntAgentRequest) {
    this.requests.push(request);
    const next = this.answers.shift();
    if (next === undefined) throw new Error('unexpected agent run');
    const output = typeof next === 'function' ? (next as (request: HuntAgentRequest) => unknown)(request) : next;
    if (output instanceof Error) throw output;
    return { output, costMicros: this.cost, turns: 5, durationMs: 1000 };
  }
}

/** Tabs: A existed before; every run «opens» one site tab and one blank tab. */
function fakeTabs() {
  let open: HuntTab[] = [{ id: 'A', url: 'https://www.linkedin.com/feed/' }];
  const closed: string[] = [];
  let opened = 0;
  const tabs: HuntTabs = {
    async list() { return open; },
    async close(ids) { closed.push(...ids); open = open.filter((tab) => !ids.includes(tab.id)); },
  };
  const agentOpens = (url: string) => { opened++; open = [...open, { id: `T${opened}`, url }]; };
  return { tabs, closed, agentOpens };
}

const silent: Logger = { info: () => {}, warn: () => {} };
const description = (title: string) => `${title}: we build Node.js services. `.repeat(10);
const listing = (jobs: { url: string; title: string; company?: string; postedAt?: string | null }[], extra: object = {}) => ({
  accessible: true, blockedAt: null, notes: '', ...extra,
  jobs: jobs.map((job) => ({ company: 'Acme', location: 'Remote', postedAt: null, ...job })),
});

describe('hunt runner on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let searches: SearchRepository;
  let jobs: JobService;
  let owner: string;
  let clockNow: Date;
  const clock = { now: () => clockNow };

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    searches = new SearchRepository(database);
    jobs = new JobService(new JobRepository(database));
    owner = (await database.user.create({ data: { email: 'hunter@example.test', name: 'Hunter', passwordHash: 'x' } })).id;
  }, 60_000);

  afterAll(async () => {
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  beforeEach(async () => {
    await database.searchRun.deleteMany({});
    await database.search.deleteMany({});
    await database.job.deleteMany({});
    clockNow = new Date('2026-11-09T10:00:00.000Z');
  });

  const service = (agent: HuntAgent, tabs: HuntTabs, maxUsd = 5) =>
    new HuntService(searches, jobs, agent, tabs, clock, silent, { maxMicrosPerDay: maxUsd * 1_000_000 });
  /** Searches run in creation order; a pause keeps creation times distinct (SQLite stores milliseconds). */
  const search = async (site: string, keywords: string, extra: { excludeTitle?: string[] } = {}) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return new SearchService(searches, jobs, [], { http: null as never, browser: null as unknown as Browser, log: silent, pause: async () => {}, random: () => 0 }, clock)
      .create({ id: owner, role: 'user' }, { source: 'agent', site, keywords, ...extra });
  };
  const signal = () => new AbortController().signal;

  it('lists, keeps new on-site jobs, rejects by title, fetches descriptions and records them like the collector', async () => {
    await search('djinni', 'node.js', { excludeTitle: ['java'] });
    await jobs.recordFound(owner, [{ url: 'https://djinni.co/jobs/1-known/', source: 'djinni', title: 'Known', company: 'Acme' }]);
    const { tabs, closed, agentOpens } = fakeTabs();
    const agent = new FakeHuntAgent([
      () => {
        agentOpens('https://djinni.co/jobs/?all_keywords=node.js');
        return listing([
          { url: 'https://djinni.co/jobs/1-known/', title: 'Known' },
          { url: 'https://djinni.co/jobs/2-node/?ref=list', title: 'Node.js Developer', postedAt: 'updated 4d ago' },
          { url: 'https://djinni.co/jobs/2-node/', title: 'Node.js Developer (repeat)' },
          { url: 'https://djinni.co/jobs/3-java/', title: 'Java Developer' },
          { url: 'https://evil.example/jobs/4-x/', title: 'Off-site' },
          { url: 'https://djinni.co/jobs/5-ts/', title: 'TypeScript Engineer', company: '' },
          { url: 'https://djinni.co/jobs/6-closed/', title: 'Backend Engineer' },
        ]);
      },
      (request: HuntAgentRequest) => {
        agentOpens('about:blank');
        expect(request.prompt).toContain('https://djinni.co/jobs/2-node/ — Node.js Developer — Acme');
        expect(request.prompt).not.toContain('3-java');
        expect(request.prompt).toContain('VERBATIM');
        return {
          accessible: true, notes: '', details: [
            { url: 'https://djinni.co/jobs/2-node/', description: description('Node') },
            { url: 'https://djinni.co/jobs/5-ts/', description: description('TS'), company: 'Beta' },
            { url: 'https://djinni.co/jobs/6-closed/', description: '' },
            { url: 'https://djinni.co/jobs/9-not-asked/', description: description('Other') },
          ],
        };
      },
    ]);

    const result = await service(agent, tabs).runSaved({ signal: signal(), ownerId: owner });
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      source: 'djinni', site: 'djinni', seen: 5, invalid: 1, fresh: 4, filtered: 1, described: 2, created: 3, stopped: 'end',
      costMicros: 200_000, blocked: null, skipped: false,
    });
    expect(agent.requests.map((request) => [request.allowedHosts, request.maxTurns])).toEqual([[['djinni.co', 'www.djinni.co'], 40], [['djinni.co', 'www.djinni.co'], 22]]);
    expect(closed).toEqual(['T1', 'T2']);

    const saved = await database.job.findMany({ where: { userId: owner }, orderBy: { url: 'asc' } });
    expect(saved.map((job) => [job.url, job.status, job.source, job.externalId, job.company])).toEqual([
      ['https://djinni.co/jobs/1-known/', 'found', 'djinni', null, 'Acme'],
      ['https://djinni.co/jobs/2-node/', 'found', 'djinni', '2', 'Acme'],
      ['https://djinni.co/jobs/3-java/', 'rejected', 'djinni', '3', 'Acme'],
      ['https://djinni.co/jobs/5-ts/', 'found', 'djinni', '5', 'Beta'],
    ]);
    const node = saved[1]!;
    expect(node.description?.startsWith('Node: we build')).toBe(true);
    expect(JSON.parse(node.raw!)).toEqual({ via: 'agent', site: 'djinni', postedAtText: 'updated 4d ago' });
    expect(node.postedAt).toEqual(new Date('2026-11-05T10:00:00.000Z'));
    // The closed job has no description: it is not saved, so the next run lists it as new again.
    expect(await jobs.unknownUrls(owner, ['https://djinni.co/jobs/6-closed/'])).toEqual(['https://djinni.co/jobs/6-closed/']);
    expect(await database.searchRun.findMany()).toMatchObject([{ described: 2, costMicros: 200_000, created: 3, filtered: 1, stopped: 'end' }]);
  });

  it('a blocked site stops its search and skips the other searches on it; other sites still run', async () => {
    await search('indeed', 'node.js');
    await search('indeed', 'typescript');
    await search('remoteok', 'node');
    const { tabs } = fakeTabs();
    const agent = new FakeHuntAgent([
      listing([], { accessible: false, blockedAt: 'Cloudflare на странице выдачи' }),
      listing([{ url: 'https://remoteok.com/remote-jobs/remote-node-dev-acme-11', title: 'Node Dev' }]),
      { accessible: true, notes: '', details: [{ url: 'https://remoteok.com/remote-jobs/remote-node-dev-acme-11', description: description('Node') }] },
    ]);
    const { reports } = await service(agent, tabs).runSaved({ signal: signal() });
    expect(reports.map((report) => [report.source, report.stopped, report.blocked, report.skipped, report.created])).toEqual([
      ['indeed', 'error', 'Cloudflare на странице выдачи', false, 0],
      ['indeed', 'error', 'Cloudflare на странице выдачи', true, 0],
      ['remoteok', 'end', null, false, 1],
    ]);
    expect(agent.requests).toHaveLength(3);
    expect(reports.map((report) => huntReportLine(report, false))).toEqual([
      'indeed «node.js»: нужна капча/вход — пропущено (Cloudflare на странице выдачи), <1 мин, $0.10',
      'indeed: нужна капча/вход — пропущено',
      'remoteok «node»: карточек 1, новых 1, с описанием 1, отсеяно по названию 0, <1 мин, $0.20; записано 1',
    ]);
  });

  it('fetches at most `limit` descriptions; the daily limit stops the next agent run', async () => {
    await search('djinni', 'node.js');
    await search('wellfound', 'node');
    const { tabs } = fakeTabs();
    const agent = new FakeHuntAgent([
      listing([1, 2, 3, 4].map((id) => ({ url: `https://djinni.co/jobs/${id}-node/`, title: `Node ${id}` }))),
      (request: HuntAgentRequest) => {
        expect(request.prompt).toContain('2-node');
        expect(request.prompt).not.toContain('3-node');
        return { accessible: true, notes: '', details: [1, 2].map((id) => ({ url: `https://djinni.co/jobs/${id}-node/`, description: description('Node') })) };
      },
    ], 300_000);
    const { reports, spentTodayMicros, budgetMicros } = await service(agent, tabs, 0.5).runSaved({ signal: signal(), limit: 2 });
    expect(reports[0]).toMatchObject({ fresh: 4, described: 2, created: 2, stopped: 'limit', costMicros: 600_000 });
    expect(reports[1]).toMatchObject({ source: 'wellfound', skipped: true, stopped: 'error', error: expect.stringContaining('HUNT_MAX_USD_PER_DAY') });
    expect([spentTodayMicros, budgetMicros]).toEqual([600_000, 500_000]);

    // The spend is stored with the run, so the next hunt the same day does not start an agent at all.
    const next = new FakeHuntAgent([]);
    expect((await service(next, tabs, 0.5).runSaved({ signal: signal() })).reports.every((report) => report.skipped)).toBe(true);
    expect(next.requests).toEqual([]);
    clockNow = new Date('2026-11-10T00:30:00.000Z');
    const tomorrow = new FakeHuntAgent([listing([]), listing([])]);
    expect((await service(tomorrow, tabs, 0.5).runSaved({ signal: signal() })).reports.map((report) => report.stopped)).toEqual(['known', 'known']);
  });

  it('an unavailable agent stops the run; a failed run is reported with its cost; a dry run writes nothing', async () => {
    await search('djinni', 'node.js');
    await search('remoteok', 'node');
    const { tabs } = fakeTabs();
    const down = new FakeHuntAgent([new HuntAgentError('claude не найден', 0, true)]);
    const first = await service(down, tabs).runSaved({ signal: signal() });
    expect(first.reports).toHaveLength(1);
    expect(first.reports[0]).toMatchObject({ stopped: 'error', error: 'claude не найден' });

    const failing = new FakeHuntAgent([new HuntAgentError('Агент закончил с error_max_turns', 70_000), listing([{ url: 'https://remoteok.com/remote-jobs/remote-x-1', title: 'Node X' }]),
      { accessible: true, notes: '', details: [{ url: 'https://remoteok.com/remote-jobs/remote-x-1', description: description('X') }] }]);
    await database.searchRun.deleteMany({});
    const dry = await service(failing, tabs).runSaved({ signal: signal(), dryRun: true });
    expect(dry.reports.map((report) => [report.stopped, report.costMicros, report.described, report.created])).toEqual([['error', 70_000, 0, 0], ['end', 200_000, 1, 0]]);
    expect(await database.job.count()).toBe(0);
    expect(await database.searchRun.count()).toBe(0);
  });

  it('LinkedIn collecting skips agent searches; an agent search needs a known site or an https address', async () => {
    await search('indeed', 'node.js');
    const linkedin = new SearchService(searches, jobs, [], { http: null as never, browser: null as unknown as Browser, log: silent, pause: async () => {}, random: () => 0 }, clock);
    expect(await linkedin.runSaved({ signal: signal(), ownerId: owner })).toEqual([]);
    const actor = { id: owner, role: 'user' as const };
    const create = async (input: Parameters<SearchService['create']>[1]) => linkedin.create(actor, input);
    await expect(create({ source: 'agent', keywords: 'node' })).rejects.toMatchObject({ code: 'INVALID_AGENT_SITE' });
    await expect(create({ source: 'agent', site: 'monster', keywords: 'node' })).rejects.toMatchObject({ code: 'INVALID_AGENT_SITE' });
    await expect(create({ source: 'linkedin', site: 'indeed', keywords: 'node' })).rejects.toMatchObject({ code: 'UNKNOWN_SEARCH_SOURCE' });
    const generic = await linkedin.create(actor, { source: 'agent', site: 'jobs.example.test/search', keywords: 'node', easyApplyOnly: true });
    expect(generic).toMatchObject({ source: 'agent', site: 'https://jobs.example.test/search', easyApplyOnly: false });
  });
});
