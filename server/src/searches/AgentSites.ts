import { ApplicationError } from '../../framework/core/errors.js';
import type { SearchQuery } from './SearchTypes.js';

/**
 * Job boards the collector agent (task `hunt`) browses until each gets its own source module.
 * Pure: how to build the search URL of a site, which hosts belong to it and how its job URL is
 * canonicalized. The agent only reads the pages; every URL it returns goes through `canonical` here,
 * so a job from another host or with a broken address never reaches the jobs table.
 *
 * A saved search keeps the site as `searches.site`: a known id (indeed, djinni…) or an https address of
 * any other board (the generic site: its host only, the URL as the start page).
 */

/** `searches.source` of a search the agent runs; the site itself is in `searches.site`. */
export const agentSourceId = 'agent';
/** How `agent` is listed among the sources. */
export const agentSiteTitle = 'Агент: другие биржи (indeed, djinni, remoteok, wellfound или https-адрес)';

export type AgentJobUrl = Readonly<{ url: string; externalId?: string }>;

export type AgentSite = Readonly<{
  /** What `searches.site` keeps: the id of a known site or the https start URL of a generic one. */
  key: string;
  /** `jobs.source` of its jobs: the same id a real source module of this site will use later. */
  id: string;
  title: string;
  /** https hosts the agent may open; anything else is denied by the guard and dropped here. */
  hosts: readonly string[];
  /** Result pages for the query, the first one first; the agent reads them in order. */
  searchUrls(query: SearchQuery): string[];
  /** The job URL without tracking; throws for a URL of another host or not a job page. */
  canonical(url: string): AgentJobUrl;
  /** Where the site keeps the list and the description, for the prompt (snapshot `target` selectors). */
  hints: string;
  /** A site that is not in the table: the agent searches with the site's own search box. */
  generic: boolean;
}>;

export class AgentUrlError extends Error {
  override name = 'AgentUrlError';
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AgentUrlError(`не URL: «${value}»`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AgentUrlError(`не http(s): «${value}»`);
  return url;
}

function onHosts(url: URL, hosts: readonly string[]): string {
  const host = url.hostname.toLowerCase();
  if (!hosts.includes(host)) throw new AgentUrlError(`чужой сайт: ${host}`);
  return host;
}

/** Lower-case words joined by «-»: «Node.js Developer» → «node-js-developer». */
export function slug(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

const remoteLocation = (location: string | undefined) => !location || /remote|удал[её]н|віддал/i.test(location);
const irishLocation = /ireland|éire|eire|dublin|cork|galway|limerick|waterford|ирланд/i;

const indeed: AgentSite = {
  key: 'indeed', id: 'indeed', title: 'Indeed', generic: false,
  hosts: ['www.indeed.com', 'ie.indeed.com'],
  searchUrls(query) {
    const host = irishLocation.test(query.location ?? '') ? 'ie.indeed.com' : 'www.indeed.com';
    const first = `https://${host}/jobs?${new URLSearchParams({ q: query.keywords, l: query.location ?? '' })}`;
    return [first, `${first}&start=10`];
  },
  canonical(value) {
    const url = parseUrl(value);
    const host = onHosts(url, indeed.hosts);
    // Job cards have no links: the job key comes from `jk`, `vjk` (the selected card) or `fromjk` (salary links).
    const jk = (url.searchParams.get('jk') ?? url.searchParams.get('vjk') ?? url.searchParams.get('fromjk') ?? '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(jk)) throw new AgentUrlError(`нет ключа вакансии Indeed (jk): ${value}`);
    return { url: `https://${host}/viewjob?jk=${jk}`, externalId: jk };
  },
  hints: [
    'Indeed: the job cards are in `#mosaic-provider-jobcards` (snapshot target); cards have no links. The 16-hex job key',
    'is the `vjk`/`jk` value of the selected card or the `fromjk` value in the card\'s salary link; the job page is',
    'https://<same host>/viewjob?jk=<key>. Skip «Sponsored» cards. The description is in `#jobDescriptionText`',
    '(or the «Full job description» section).',
  ].join(' '),
};

const djinni: AgentSite = {
  key: 'djinni', id: 'djinni', title: 'Djinni', generic: false,
  hosts: ['djinni.co', 'www.djinni.co'],
  searchUrls(query) {
    const first = `https://djinni.co/jobs/?${new URLSearchParams({ all_keywords: query.keywords, remote_type: 'full_remote' })}`;
    return [first, `${first}&page=2`];
  },
  canonical(value) {
    const url = parseUrl(value);
    onHosts(url, djinni.hosts);
    const match = url.pathname.match(/^\/jobs\/(\d+)(-[\w-]*)?\/?$/);
    if (!match) throw new AgentUrlError(`не страница вакансии Djinni: ${value}`);
    return { url: `https://djinni.co/jobs/${match[1]}${match[2] ?? ''}/`, externalId: match[1]! };
  },
  hints: 'Djinni: job links are /jobs/<id>-<slug>/ (relative: prefix https://djinni.co). The list is `ul.list-jobs`; '
    + 'the description is `.job-post__description`. «updated Nd ago» is the posted date.',
};

const remoteok: AgentSite = {
  key: 'remoteok', id: 'remoteok', title: 'Remote OK', generic: false,
  hosts: ['remoteok.com', 'www.remoteok.com'],
  searchUrls(query) {
    // Tags are single words: «node.js» → node, «react native» → react-native.
    const tag = slug(query.keywords.replace(/\.js\b/gi, '')) || 'dev';
    return [`https://remoteok.com/remote-${tag}-jobs`];
  },
  canonical(value) {
    const url = parseUrl(value);
    onHosts(url, remoteok.hosts);
    const match = url.pathname.match(/^\/remote-jobs\/((?:[\w-]*-)?(\d+))\/?$/);
    if (!match) throw new AgentUrlError(`не страница вакансии Remote OK: ${value}`);
    return { url: `https://remoteok.com/remote-jobs/${match[1]}`, externalId: match[2]! };
  },
  hints: 'Remote OK: the page is huge — snapshot only `#jobsboard`; job links are /remote-jobs/remote-<slug>-<id>. '
    + 'Skip «Promoted» and banner rows. On a job page the description is `.description >> nth=0`. Ages are like «4d», «1mo».',
};

const wellfound: AgentSite = {
  key: 'wellfound', id: 'wellfound', title: 'Wellfound', generic: false,
  hosts: ['wellfound.com', 'www.wellfound.com'],
  searchUrls(query) {
    const role = slug(query.keywords);
    const first = remoteLocation(query.location)
      ? `https://wellfound.com/role/r/${role}`
      : `https://wellfound.com/role/l/${role}/${slug(query.location ?? '')}`;
    return [first, `${first}?page=2`];
  },
  canonical(value) {
    const url = parseUrl(value);
    onHosts(url, wellfound.hosts);
    const match = url.pathname.match(/^(?:\/company\/[\w-]+)?\/jobs\/(\d+)(-[\w-]*)?\/?$/);
    if (!match) throw new AgentUrlError(`не страница вакансии Wellfound: ${value}`);
    return { url: `https://wellfound.com/jobs/${match[1]}${match[2] ?? ''}`, externalId: match[1]! };
  },
  hints: 'Wellfound: job links are /jobs/<id>-<slug> (relative: prefix https://wellfound.com). A cookie dialog may '
    + 'appear — «Reject All». If the role page has no results, say so in notes; do not use the login-only search.',
};

export const agentSites: readonly AgentSite[] = [indeed, djinni, remoteok, wellfound];

/** Query parameters that only track a visit. */
const trackingParams = /^(utm_\w+|ref|ref_?src|referrer|source|src|gclid|fbclid|msclkid|mc_cid|mc_eid|trk|trackingid|refid|_hs\w+|igshid)$/i;

/** Any board given by its address: only its host is allowed; the URL is the start page. */
function genericSite(start: URL): AgentSite {
  const host = start.hostname.toLowerCase();
  start.hash = '';
  const key = start.toString();
  return {
    key, id: host.replace(/^www\./, ''), title: host, generic: true, hosts: [host],
    searchUrls(query) {
      // `{q}` and `{l}` in the saved address take the keywords and the location.
      const fill = (url: string, name: string, value: string) => url.replaceAll(`{${name}}`, value).replaceAll(`%7B${name}%7D`, value);
      return [fill(fill(key, 'q', encodeURIComponent(query.keywords)), 'l', encodeURIComponent(query.location ?? ''))];
    },
    canonical(value) {
      const url = parseUrl(value);
      onHosts(url, [host]);
      url.hash = '';
      for (const name of [...url.searchParams.keys()]) if (trackingParams.test(name)) url.searchParams.delete(name);
      return { url: url.toString() };
    },
    hints: `Any job board: job links must be on ${host}. If the start page is not a results page, use the site's own `
      + 'search box (type the keywords, then click its Search button).',
  };
}

const invalidSite = (site: string) => new ApplicationError(
  'INVALID_AGENT_SITE',
  `Сайт «${site}» не распознан: ${agentSites.map((known) => known.id).join(', ')} или https-адрес страницы поиска.`,
  400,
);

/**
 * The site of a saved search: a known id (case-insensitive) or an https address / bare host of another
 * board. Throws INVALID_AGENT_SITE for anything else.
 */
export function resolveAgentSite(value: string): AgentSite {
  const site = value.trim();
  const known = agentSites.find((candidate) => candidate.key === site.toLowerCase());
  if (known) return known;
  if (!site || site.length > 300 || /\s/.test(site)) throw invalidSite(value);
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(site) ? site : `https://${site}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { throw invalidSite(value); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) throw invalidSite(value);
  const sameHost = agentSites.find((candidate) => candidate.hosts.includes(url.hostname.toLowerCase()));
  // An address of a known board keeps its canonical rules, but starts where the owner pointed.
  if (sameHost) return { ...sameHost, key: url.toString().replace(/#.*$/, ''), searchUrls: () => [url.toString().replace(/#.*$/, '')] };
  return genericSite(url);
}

/** A short name of a saved site for messages: the id of a known site, the host of an address. */
export function agentSiteLabel(key: string | null): string {
  if (!key) return agentSourceId;
  if (agentSites.some((site) => site.key === key)) return key;
  try { return new URL(key).hostname.replace(/^www\./, ''); } catch { return key; }
}
