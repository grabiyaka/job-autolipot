import type { BrowserLink, JobCard, JobDetails, SearchQuery } from './SearchTypes.js';

/**
 * Everything LinkedIn-specific that can be decided without a browser: URLs, link and page-title
 * formats, section markers of the job text. Formats were checked against live LinkedIn on
 * 2026-11-03 (signed-in session, English UI); see tests/fixtures/linkedin. Anything not recognized
 * stays undefined and is never guessed.
 */

export const linkedinBase = 'https://www.linkedin.com';
const host = 'www.linkedin.com';
/** LinkedIn shows 25 results per search page; `start` moves by that. */
export const resultsPerPage = 25;
const remoteFilter = '2'; // f_WT (workplace type): 2 = remote

const idPattern = /^[0-9]{1,20}$/;
const slugIdPattern = /^[a-z0-9%_.-]*-([0-9]{1,20})$/; // /jobs/view/backend-engineer-at-acme-1234567890/
const wallPaths = ['/login', '/authwall', '/checkpoint', '/uas/'];

/**
 * Newest first. A location "Remote" becomes the remote filter instead of a place.
 * `skipRedirect=true` keeps the classic results list: since 2026-11-03 LinkedIn sends this account from
 * /jobs/search/ to the AI search (/jobs/search-results/), whose cards are not links and carry no job id.
 */
export function searchUrl(query: SearchQuery, page: number): string {
  const params = new URLSearchParams({ keywords: query.keywords });
  const location = query.location?.trim();
  if (location && location.toLowerCase() === 'remote') params.set('f_WT', remoteFilter);
  else if (location) params.set('location', location);
  params.set('sortBy', 'DD');
  if (page > 0) params.set('start', String(page * resultsPerPage));
  params.set('skipRedirect', 'true');
  return `${linkedinBase}/jobs/search/?${params.toString()}`;
}

export function jobViewUrl(jobId: string): string {
  return `${linkedinBase}/jobs/view/${jobId}/`;
}

/**
 * The job id of a LinkedIn job link, or undefined when it is not one.
 * Recognized: /jobs/view/<id>/, /jobs/view/<slug>-<id>/ and ?currentJobId=<id> on a /jobs/ page.
 */
export function jobIdFromUrl(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname !== host) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 3 && parts[0] === 'jobs' && parts[1] === 'view') {
    const last = parts[2]!;
    if (idPattern.test(last)) return last;
    return slugIdPattern.exec(last.toLowerCase())?.[1];
  }
  if (parts[0] === 'jobs') {
    const current = url.searchParams.getAll('currentJobId');
    if (current.length === 1 && idPattern.test(current[0]!)) return current[0];
  }
  return undefined;
}

/** True when LinkedIn sent the tab to a sign-in, authwall or checkpoint page instead. */
export function isWall(value: string): boolean {
  let path: string;
  try { path = new URL(value).pathname; } catch { return false; }
  return wallPaths.some((prefix) => path.startsWith(prefix));
}

const pathOf = (value: string): string | undefined => {
  try { return new URL(value).pathname; } catch { return undefined; }
};

/** The classic results list, whose cards are /jobs/view/ links. */
export function isSearchPage(value: string): boolean {
  const path = pathOf(value);
  return path === '/jobs/search' || path === '/jobs/search/';
}

/** The AI search: its cards have no links, so job ids cannot be read from it. */
export function isAiSearchPage(value: string): boolean {
  return pathOf(value)?.startsWith('/jobs/search-results') ?? false;
}

/**
 * Link text → job title. The text can repeat the title (visible and screen-reader copies)
 * and carry a " with verification" badge.
 */
export function cleanTitle(text: string): string {
  const words = text.replace(/\bwith verification\b/gi, ' ').split(/\s+/).filter(Boolean);
  const half = words.length / 2;
  if (words.length % 2 === 0 && words.slice(0, half).join(' ') === words.slice(half).join(' ')) return words.slice(0, half).join(' ');
  return words.join(' ');
}

/**
 * Job cards of a search page, in page order, one per job id. Only /jobs/view/ links are cards whose text
 * is the title; ?currentJobId= links can carry any text. The card has no company yet: details() adds it.
 */
export function cardsFromLinks(links: readonly BrowserLink[]): JobCard[] {
  const titles = new Map<string, string>();
  for (const link of links) {
    const id = jobIdFromUrl(link.href);
    if (!id) continue;
    const isCard = new URL(link.href).pathname.startsWith('/jobs/view/');
    const title = isCard ? cleanTitle(link.text) : '';
    if (!titles.get(id)) titles.set(id, title);
  }
  return [...titles].map(([id, title]) => ({ url: jobViewUrl(id), externalId: id, title, company: '' }));
}

/**
 * Cards seen so far plus the cards of a later read, in first-seen order. The results list is virtualized:
 * a card renders only once scrolled into view, so each read shows part of the page.
 */
export function mergeCards(seen: readonly JobCard[], more: readonly JobCard[]): JobCard[] {
  const byUrl = new Map(seen.map((card) => [card.url, card]));
  for (const card of more) {
    const known = byUrl.get(card.url);
    if (!known) byUrl.set(card.url, card);
    else if (!known.title && card.title) byUrl.set(card.url, { ...known, title: card.title });
  }
  return [...byUrl.values()];
}

/**
 * Signed-in document title of a job page: "(3) Backend Engineer | Acme | LinkedIn". Titles and company
 * names can both contain " | " ("Godot Game Developer | $100/hr | Remote | The Ai Training Company"), so
 * when the title from the search card is known and the page title starts with it, the rest is the company.
 */
export function parsePageTitle(pageTitle: string, knownTitle?: string): { title?: string; company?: string } {
  const text = pageTitle.split(/\s+/).filter(Boolean).join(' ').replace(/^\(\d+\)\s*/, '');
  const known = knownTitle?.split(/\s+/).filter(Boolean).join(' ');
  if (known && text.startsWith(`${known} | `) && text.endsWith(' | LinkedIn')) {
    const company = text.slice(known.length + 3, -' | LinkedIn'.length).trim();
    if (company) return { title: known, company };
  }
  const match = /^(?:\(\d+\)\s*)?(?<title>.+?) \| (?<company>.+?) \| LinkedIn$/.exec(text);
  return match?.groups ? { title: match.groups.title!, company: match.groups.company! } : {};
}

const descriptionStart = 'About the job';
/**
 * The description ends at the earliest of these. A long description is cut with "… more" and followed by
 * the job-alert block and "About the company"; a short one is shown in full and followed directly by the
 * Premium upsell and the page footer (both seen live on 2026-11-03).
 */
const descriptionEnds = [
  'Set alert for similar jobs', 'About the company', 'Job search smarter with Premium', 'Looking for talent?', 'LinkedIn Corporation ©',
];
const trailingMore = /\n[ \t]*(?:…|\.\.\.)[ \t]*more[ \t]*$/;
const postedAgo = /^(?:reposted\s+)?(?:\d+|an?)\s+(?:minute|hour|day|week|month|year)s?\s+ago$/i;
const maxLocation = 120;

export function hasDescription(pageText: string): boolean {
  return pageText.includes(descriptionStart);
}

/**
 * The "About the job" section up to the first end marker; a trailing "… more" line is dropped.
 * The rest of the page (job alert, Premium insights, footer) is not description.
 */
export function jobDescription(pageText: string): string | undefined {
  const start = pageText.indexOf(descriptionStart);
  if (start < 0) return undefined;
  let text = pageText.slice(start + descriptionStart.length);
  const ends = descriptionEnds.map((marker) => text.indexOf(marker)).filter((index) => index >= 0);
  if (ends.length) text = text.slice(0, Math.min(...ends));
  return `\n${text.trim()}`.replace(trailingMore, '').trim() || undefined;
}

/**
 * Location from the header line "Lisbon, Portugal · 18 minutes ago · 1 person clicked apply" before
 * "About the job". Undefined when there is no such line or the lines disagree.
 */
export function headerLocation(pageText: string): string | undefined {
  const header = pageText.split(descriptionStart, 1)[0] ?? '';
  const found = new Set<string>();
  for (const line of header.split('\n')) {
    const parts = line.split(' · ').map((part) => part.trim());
    if (parts.length < 2 || !postedAgo.test(parts[1]!)) continue;
    const location = parts[0]!.split(/\s+/).filter(Boolean).join(' ');
    if (location && location.length <= maxLocation) found.add(location);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** "Easy Apply" is a whole line of the header when the job takes applications on LinkedIn itself. */
export function isEasyApply(pageText: string): boolean {
  const header = pageText.split(descriptionStart, 1)[0] ?? '';
  return header.split('\n').some((line) => line.trim() === 'Easy Apply');
}

/** What a job page adds to its card; `cardTitle` is the title from the search results, if any. */
export function jobPageDetails(pageTitle: string, pageText: string, jobId: string, cardTitle?: string): JobDetails {
  const fromTitle = parsePageTitle(pageTitle, cardTitle);
  const location = headerLocation(pageText);
  const description = jobDescription(pageText);
  return {
    ...fromTitle,
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    raw: { jobId, easyApply: isEasyApply(pageText) },
  };
}
