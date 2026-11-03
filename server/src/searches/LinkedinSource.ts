import {
  cardsFromLinks, hasDescription, isSearchPage, isWall, jobIdFromUrl, jobPageDetails, jobViewUrl, searchUrl,
} from './LinkedinParser.js';
import { BrowserError, SourceStopError } from './SearchTypes.js';
import type { JobCard, JobDetails, JobSource, SearchQuery, SourceContext } from './SearchTypes.js';

/**
 * LinkedIn through the shared, signed-in agent Chromium (read-only browser).
 *
 *   search:  open a search page (newest first), scroll a few times so more cards load, read the job links;
 *            the next page is the same search with `start` moved by 25
 *   details: open https://www.linkedin.com/jobs/view/<id>/ and read company, location and description
 *
 * The real LinkedIn account sits behind this browser, so browsing is slow and bounded. A sign-in,
 * authwall or checkpoint page stops the search and the other LinkedIn searches of the run.
 */

/** Scrolls per search page: on 2026-11-03 three scrolls loaded 17 of 25 cards, a fourth added none. */
const scrollsPerPage = 3;
const scrollWaitMs = 1500;
/** Pages after the first render their cards a second or two after loading; an empty read is retried. */
const renderRetries = 3;
const renderWaitMs = 2000;
/** Pause before each job page, on top of the runner's pause between search pages. */
const jobPageDelayMs = 4000;
/** "About the job" renders a few seconds after the page loads, so the text is re-read until it appears. */
const textRetries = 3;
const textRetryWaitMs = 2000;

function stopIfWalled(url: string): void {
  if (isWall(url)) {
    throw new SourceStopError(`LinkedIn требует вход или проверку (${new URL(url).pathname}); войдите в agent Chromium через noVNC`);
  }
}

async function searchPage(context: SourceContext, query: SearchQuery, page: number): Promise<JobCard[]> {
  const opened = await context.browser.open(searchUrl(query, page));
  stopIfWalled(opened.url);
  if (!isSearchPage(opened.url)) throw new BrowserError(`поиск LinkedIn открыл неожиданную страницу: ${opened.url}`);

  let cards = cardsFromLinks((await context.browser.links()).links);
  for (let retry = 0; retry < renderRetries && !cards.length; retry++) {
    await context.pause(renderWaitMs);
    cards = cardsFromLinks((await context.browser.links()).links);
  }
  // Still no cards after the render wait: the search has no (more) results.
  if (!cards.length) return cards;
  for (let step = 0; step < scrollsPerPage; step++) {
    await context.browser.scroll(5);
    await context.pause(scrollWaitMs);
    const { url, links } = await context.browser.links();
    stopIfWalled(url);
    const more = cardsFromLinks(links);
    if (more.length <= cards.length) break;
    cards = more;
  }
  return cards;
}

export const linkedinSource: JobSource = {
  id: 'linkedin',
  title: 'LinkedIn',
  limits: { pageDelayMs: [6000, 12000], maxPagesPerQuery: 4 },

  async *search(context, query) {
    for (let page = 0; ; page++) {
      const cards = await searchPage(context, query, page);
      if (!cards.length) return;
      yield cards;
    }
  },

  async details(context, card): Promise<JobDetails> {
    const jobId = jobIdFromUrl(card.url);
    if (!jobId) throw new BrowserError(`не ссылка на вакансию LinkedIn: ${card.url}`);
    await context.pause(jobPageDelayMs);
    const opened = await context.browser.open(jobViewUrl(jobId));
    stopIfWalled(opened.url);
    if (jobIdFromUrl(opened.url) !== jobId) throw new BrowserError(`страница вакансии ${jobId} перенаправила на ${opened.url}`);

    let { text } = await context.browser.text();
    for (let retry = 0; retry < textRetries && !hasDescription(text); retry++) {
      await context.pause(textRetryWaitMs);
      ({ text } = await context.browser.text());
    }
    return jobPageDetails(opened.title, text, jobId, card.title);
  },

  canonicalUrl(url) {
    const jobId = jobIdFromUrl(url);
    if (!jobId) throw new Error(`не ссылка на вакансию LinkedIn: ${url}`);
    return jobViewUrl(jobId);
  },
};
