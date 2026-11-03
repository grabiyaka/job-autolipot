import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cardsFromLinks, cleanTitle, headerLocation, isEasyApply, isWall, jobDescription, jobIdFromUrl, jobPageDetails,
  parsePageTitle, searchUrl,
} from '../src/searches/LinkedinParser.js';
import { linkedinSource } from '../src/searches/LinkedinSource.js';
import { BrowserError, SourceStopError } from '../src/searches/SearchTypes.js';
import type { Browser, BrowserLink, JobCard, SourceContext } from '../src/searches/SearchTypes.js';

/** Captured from live LinkedIn on 2026-11-03 (tracking ids blanked, page footer dropped). */
const searchFixture = JSON.parse(readFileSync(new URL('./fixtures/linkedin/search-page.json', import.meta.url), 'utf8')) as {
  url: string; title: string; links: BrowserLink[];
};
const fullDescriptionFixture = JSON.parse(readFileSync(new URL('./fixtures/linkedin/job-page-full-description.json', import.meta.url), 'utf8')) as {
  title: string; text: string;
};
const jobFixture = JSON.parse(readFileSync(new URL('./fixtures/linkedin/job-page.json', import.meta.url), 'utf8')) as {
  url: string; title: string; text: string;
};

describe('LinkedIn parser', () => {
  it('builds newest-first search URLs; "Remote" becomes the remote filter', () => {
    expect(searchUrl({ keywords: 'node.js', location: 'Remote' }, 0))
      .toBe('https://www.linkedin.com/jobs/search/?keywords=node.js&f_WT=2&sortBy=DD');
    expect(searchUrl({ keywords: 'vue developer', location: 'Dublin, Ireland' }, 2))
      .toBe('https://www.linkedin.com/jobs/search/?keywords=vue+developer&location=Dublin%2C+Ireland&sortBy=DD&start=50');
  });

  it('recognizes job links and nothing else', () => {
    expect(jobIdFromUrl('https://www.linkedin.com/jobs/view/4484680584/?eBP=X&refId=x&trk=flagship3_search_srp_jobs')).toBe('4484680584');
    expect(jobIdFromUrl('https://www.linkedin.com/jobs/view/backend-engineer-at-acme-1234567890/')).toBe('1234567890');
    expect(jobIdFromUrl('https://www.linkedin.com/jobs/search/?currentJobId=42&keywords=x')).toBe('42');
    for (const url of [
      'https://www.linkedin.com/company/kake/life', 'http://www.linkedin.com/jobs/view/1/', 'https://evil.test/jobs/view/1/',
      'https://www.linkedin.com/jobs/view/abc/', 'not a url',
    ]) expect(jobIdFromUrl(url), url).toBeUndefined();
  });

  it('turns a live search page into one card per job, in page order, with clean titles', () => {
    const cards = cardsFromLinks(searchFixture.links);
    expect(cards).toHaveLength(15);
    expect(cards[0]).toEqual({ url: 'https://www.linkedin.com/jobs/view/4484680584/', externalId: '4484680584', title: 'Senior QA Engineer - Remote', company: '' });
    expect(cards.map((card) => card.title)).toContain('Godot Game Developer | $100/hr | Remote');
    expect(new Set(cards.map((card) => card.externalId)).size).toBe(15);
    expect(cleanTitle('Backend Engineer with verification Backend Engineer with verification')).toBe('Backend Engineer');
  });

  it('reads company, title, location and description from a live job page', () => {
    expect(parsePageTitle(jobFixture.title)).toEqual({ title: 'Senior QA Engineer - Remote', company: 'Kake' });
    expect(parsePageTitle('(6) Backend Engineer | Acme | LinkedIn')).toEqual({ title: 'Backend Engineer', company: 'Acme' });
    expect(parsePageTitle('Jobs | LinkedIn')).toEqual({});
    // Live 2026-11-03: pipes in the title and in the company name.
    const godot = 'Godot Game Developer | $100/hr | Remote | The Ai Training Company | LinkedIn';
    expect(parsePageTitle(godot, 'Godot Game Developer | $100/hr | Remote')).toEqual({ title: 'Godot Game Developer | $100/hr | Remote', company: 'The Ai Training Company' });
    expect(parsePageTitle('(2) NodeJs with French | Floating Dots | custom software development | LinkedIn', 'NodeJs with French'))
      .toEqual({ title: 'NodeJs with French', company: 'Floating Dots | custom software development' });
    expect(parsePageTitle(godot, 'Something else')).toEqual({ title: 'Godot Game Developer', company: '$100/hr | Remote | The Ai Training Company' });
    expect(headerLocation(jobFixture.text)).toBe('Lisbon, Portugal');
    expect(isEasyApply(jobFixture.text)).toBe(false);

    const description = jobDescription(jobFixture.text)!;
    expect(description.startsWith('Senior QA Engineer - Remote')).toBe(true);
    expect(description).toContain('5+ years of experience in Quality Assurance');
    expect(description.endsWith('only shortlisted candidates will be contacted.')).toBe(true);
    for (const noise of ['Set alert for similar jobs', 'About the company', 'Reactivate Premium', '… more']) expect(description).not.toContain(noise);

    expect(jobPageDetails(jobFixture.title, jobFixture.text, '4484680584')).toEqual({
      title: 'Senior QA Engineer - Remote', company: 'Kake', location: 'Lisbon, Portugal', description,
      raw: { jobId: '4484680584', easyApply: false },
    });
  });

  it('ends a description shown in full before the Premium upsell and the footer', () => {
    const description = jobDescription(fullDescriptionFixture.text)!;
    expect(description.endsWith('disability or other legally protected statuses.')).toBe(true);
    for (const noise of ['Premium', 'LinkedIn Corporation', 'Looking for talent']) expect(description).not.toContain(noise);
    expect(jobPageDetails(fullDescriptionFixture.title, fullDescriptionFixture.text, '1')).toMatchObject({
      company: 'ElevenLabs', title: 'Full-Stack Engineer - Ads Engine', location: 'Bulgaria', raw: { easyApply: true },
    });
  });

  it('leaves unknown parts undefined instead of guessing', () => {
    expect(jobDescription('Kake\nSenior QA Engineer')).toBeUndefined();
    expect(headerLocation('A · 1 hour ago\nB · 2 hours ago\nAbout the job\n')).toBeUndefined();
    expect(isEasyApply('Acme\nEngineer\nEasy Apply\nAbout the job\nApply via Easy Apply')).toBe(true);
    expect(jobPageDetails('Untitled', 'no markers', '1')).toEqual({ raw: { jobId: '1', easyApply: false } });
  });

  it('spots sign-in walls', () => {
    for (const url of ['https://www.linkedin.com/login?x=1', 'https://www.linkedin.com/authwall?trk=1', 'https://www.linkedin.com/checkpoint/challenge/x', 'https://www.linkedin.com/uas/login']) {
      expect(isWall(url), url).toBe(true);
    }
    expect(isWall('https://www.linkedin.com/jobs/search/?keywords=x')).toBe(false);
  });
});

type Page = { url: string; title: string; text?: string; links?: BrowserLink[] };

/** A scripted tab: `open` looks the URL up; each `links()` call on a search page can return more links. */
function fakeBrowser(pages: Record<string, Page | Page[]>) {
  const opened: string[] = [];
  let current: Page | undefined;
  let linkCalls = 0;
  let textCalls = 0;
  const views = new Map<string, number>();
  const browser: Browser = {
    async open(url) {
      opened.push(url);
      const entry = pages[url];
      if (!entry) throw new BrowserError(`unexpected open ${url}`);
      const seen = views.get(url) ?? 0;
      views.set(url, seen + 1);
      current = Array.isArray(entry) ? entry[0]! : entry;
      linkCalls = 0;
      textCalls = 0;
      return { url: current.url, title: current.title, status: 200 };
    },
    async currentPage() { return current ? { url: current.url, title: current.title } : null; },
    async text() {
      const entry = Object.values(pages).find((value) => (Array.isArray(value) ? value[0]! : value) === current);
      const variants = Array.isArray(entry) ? entry : [current!];
      const page = variants[Math.min(textCalls++, variants.length - 1)]!;
      return { url: page.url, text: page.text ?? '' };
    },
    async links() {
      const entry = Object.values(pages).find((value) => (Array.isArray(value) ? value[0]! : value) === current);
      const variants = Array.isArray(entry) ? entry : [current!];
      const page = variants[Math.min(linkCalls++, variants.length - 1)]!;
      return { url: page.url, links: page.links ?? [] };
    },
    async scroll() {},
  };
  return { browser, opened };
}

function contextWith(browser: Browser, pauses: number[] = []): SourceContext {
  return {
    browser, http: { text: async () => '', json: async () => { throw new Error('no http'); } },
    log: { info: () => {}, warn: () => {} }, signal: new AbortController().signal,
    pause: async (ms) => { pauses.push(ms); },
  };
}

const jobLink = (id: number, text = `Job ${id}`): BrowserLink => ({ href: `https://www.linkedin.com/jobs/view/${id}/?trk=x`, text });

async function collect(iterable: AsyncIterable<JobCard[]>): Promise<JobCard[][]> {
  const pages: JobCard[][] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

describe('LinkedIn source on a scripted browser', () => {
  const query = { keywords: 'node.js', location: 'Remote' };
  const page0 = searchUrl(query, 0);
  const page1 = searchUrl(query, 1);

  it('scrolls while more cards load, pages with start and ends on an empty page', async () => {
    const { browser, opened } = fakeBrowser({
      [page0]: [
        { url: page0, title: 'Jobs', links: [jobLink(1)] },
        { url: page0, title: 'Jobs', links: [jobLink(1), jobLink(2)] },
        { url: page0, title: 'Jobs', links: [jobLink(1), jobLink(2)] },
      ],
      [page1]: { url: page1, title: 'Jobs', links: [] },
    });
    const pauses: number[] = [];
    const pages = await collect(linkedinSource.search(contextWith(browser, pauses), query));
    expect(pages.map((page) => page.map((card) => card.externalId))).toEqual([['1', '2']]);
    expect(opened).toEqual([page0, page1]);
    // Page 1: two scrolls (the second loads nothing new). Page 2: three render waits, still empty.
    expect(pauses).toEqual([1500, 1500, 2000, 2000, 2000]);
  });

  it('waits for cards that render after the page has loaded', async () => {
    const { browser } = fakeBrowser({
      [page0]: [
        { url: page0, title: 'Jobs', links: [] },
        { url: page0, title: 'Jobs', links: [] },
        { url: page0, title: 'Jobs', links: [jobLink(5)] },
      ],
      [page1]: { url: page1, title: 'Jobs', links: [] },
    });
    const pages = await collect(linkedinSource.search(contextWith(browser), query));
    expect(pages.map((page) => page.map((card) => card.externalId))).toEqual([['5']]);
  });

  it('stops on a sign-in wall and on an unexpected page', async () => {
    const walled = fakeBrowser({ [page0]: { url: 'https://www.linkedin.com/authwall?trk=x', title: 'Sign in' } });
    await expect(collect(linkedinSource.search(contextWith(walled.browser), query))).rejects.toBeInstanceOf(SourceStopError);
    const elsewhere = fakeBrowser({ [page0]: { url: 'https://www.linkedin.com/feed/', title: 'Feed' } });
    await expect(collect(linkedinSource.search(contextWith(elsewhere.browser), query))).rejects.toThrow(/неожиданную страницу/);
  });

  it('reads a job page, waiting until "About the job" renders', async () => {
    const url = 'https://www.linkedin.com/jobs/view/4484680584/';
    const { browser } = fakeBrowser({
      [url]: [
        { url, title: jobFixture.title, text: 'Kake\nSenior QA Engineer - Remote\nloading' },
        { url, title: jobFixture.title, text: jobFixture.text },
      ],
    });
    const pauses: number[] = [];
    const details = await linkedinSource.details!(contextWith(browser, pauses), { url, title: 'Senior QA Engineer - Remote', company: '' });
    expect(details).toMatchObject({ company: 'Kake', location: 'Lisbon, Portugal' });
    expect(pauses).toEqual([4000, 2000]);
  });

  it('refuses a job page that redirected elsewhere or hit a wall', async () => {
    const url = 'https://www.linkedin.com/jobs/view/7/';
    const card = { url, title: 'x', company: '' };
    const redirected = fakeBrowser({ [url]: { url: 'https://www.linkedin.com/jobs/view/8/', title: 'x' } });
    await expect(linkedinSource.details!(contextWith(redirected.browser), card)).rejects.toThrow(/перенаправила/);
    const walled = fakeBrowser({ [url]: { url: 'https://www.linkedin.com/checkpoint/challenge/x', title: 'x' } });
    await expect(linkedinSource.details!(contextWith(walled.browser), card)).rejects.toBeInstanceOf(SourceStopError);
  });

  it('keys jobs by id', () => {
    expect(linkedinSource.canonicalUrl('https://www.linkedin.com/jobs/view/slug-at-acme-55/?trk=1')).toBe('https://www.linkedin.com/jobs/view/55/');
    expect(() => linkedinSource.canonicalUrl('https://www.linkedin.com/feed/')).toThrow();
  });
});
