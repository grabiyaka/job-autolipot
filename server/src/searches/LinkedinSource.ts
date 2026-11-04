import {
  cardsFromLinks, hasDescription, isAiSearchPage, isSearchPage, isWall, jobIdFromUrl, jobPageDetails, jobViewUrl, mergeCards,
  resultsPerPage, searchUrl,
} from './LinkedinParser.js';
import { BrowserError, SourceStopError } from './SearchTypes.js';
import type { JobCard, JobDetails, JobSource, SearchQuery, SourceContext } from './SearchTypes.js';

/**
 * LinkedIn through the shared, signed-in agent Chromium (read-only browser).
 *
 *   search:  open the classic search page (newest first), scroll the results list a screen at a time and
 *            gather the job links of every read;
 *            the next page is the same search with `start` moved by 25
 *   details: open https://www.linkedin.com/jobs/view/<id>/ and read company, location and description
 *
 * The real LinkedIn account sits behind this browser, so browsing is slow and bounded. A sign-in,
 * authwall or checkpoint page stops the search and the other LinkedIn searches of the run.
 */

/**
 * The results list is virtualized: a card renders only once it has been in view, so a big scroll jumps over
 * the middle of the list (live 2026-11-03: scroll(5) gave 7 + 7 of 25). One screen at a time with the cards
 * of every read gathered gave 7 → 13 → 20 → 25 on two searches. The list ends after two reads add nothing.
 */
const maxScrolls = 8;
const idleScrollsToStop = 2;
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
  if (isAiSearchPage(opened.url)) {
    throw new SourceStopError('LinkedIn открыл AI-поиск (/jobs/search-results) вместо обычной выдачи: в нём нет ссылок на вакансии');
  }
  if (!isSearchPage(opened.url)) throw new BrowserError(`поиск LinkedIn открыл неожиданную страницу: ${opened.url}`);

  let cards = cardsFromLinks((await context.browser.links()).links);
  for (let retry = 0; retry < renderRetries && !cards.length; retry++) {
    await context.pause(renderWaitMs);
    cards = cardsFromLinks((await context.browser.links()).links);
  }
  // Still no cards after the render wait: the search has no (more) results.
  if (!cards.length) return cards;
  let idle = 0;
  for (let step = 0; step < maxScrolls && idle < idleScrollsToStop && cards.length < resultsPerPage; step++) {
    await context.browser.scroll(1);
    await context.pause(scrollWaitMs);
    const { url, links } = await context.browser.links();
    stopIfWalled(url);
    const merged = mergeCards(cards, cardsFromLinks(links));
    idle = merged.length > cards.length ? 0 : idle + 1;
    cards = merged;
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
