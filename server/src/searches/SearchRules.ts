import { ApplicationError } from '../../framework/core/errors.js';
import type { JobCard, JobSource, SearchQuery } from './SearchTypes.js';

export const searchStopReasons = ['end', 'known', 'limit', 'aborted', 'error'] as const;
export type SearchStopReason = typeof searchStopReasons[number];

export type SearchFields = Readonly<{
  source: string; keywords: string; location: string | null; includeTitle: string[]; excludeTitle: string[];
}>;
export type SearchFieldsInput = Readonly<{
  source: string; keywords: string; location?: string | null;
  includeTitle?: readonly string[] | null; excludeTitle?: readonly string[] | null;
}>;

const maxTerms = 50;
const maxTermLength = 60;

/** Lower-case, trimmed, unique words or phrases of a title filter. */
export function titleTerms(terms: readonly string[] | null | undefined): string[] {
  const unique = [...new Set((terms ?? []).map((term) => term.trim().toLowerCase().split(/\s+/).join(' ')).filter(Boolean))];
  if (unique.length > maxTerms || unique.some((term) => term.length > maxTermLength)) {
    throw new ApplicationError('INVALID_SEARCH', `Фильтр по названию: до ${maxTerms} слов, каждое до ${maxTermLength} символов.`, 400);
  }
  return unique;
}

const wordChar = /[\p{L}\p{N}]/u;

/**
 * Whether `term` occurs in `title` as a whole word or phrase: "java" matches "Java Developer" but not
 * "JavaScript Developer"; "node" matches "Node.js"; "c++" and ".net" work as written. Case-insensitive.
 */
export function titleHas(title: string, term: string): boolean {
  const text = title.toLowerCase().split(/\s+/).join(' ');
  for (let index = text.indexOf(term); index >= 0; index = text.indexOf(term, index + 1)) {
    const before = text[index - 1];
    const after = text[index + term.length];
    const startsWord = wordChar.test(term[0]!);
    const endsWord = wordChar.test(term[term.length - 1]!);
    if ((!startsWord || before === undefined || !wordChar.test(before)) && (!endsWord || after === undefined || !wordChar.test(after))) return true;
  }
  return false;
}

export type TitleFilter = Readonly<{ includeTitle: readonly string[]; excludeTitle: readonly string[] }>;

/**
 * Why a job title does not pass the search's title filter, or null when it passes. An excluded word
 * always rejects; with include words, at least one must be present. An empty title is not judged here.
 */
export function titleRejection(title: string, filter: TitleFilter): string | null {
  if (!title.trim()) return null;
  const excluded = filter.excludeTitle.find((term) => titleHas(title, term));
  if (excluded) return `название: исключено «${excluded}»`;
  if (filter.includeTitle.length && !filter.includeTitle.some((term) => titleHas(title, term))) {
    const shown = filter.includeTitle.slice(0, 3).map((term) => `«${term}»`).join(', ');
    const more = filter.includeTitle.length - 3;
    return `название: нет ни одного из ${shown}${more > 0 ? ` и ещё ${more}` : ''}`;
  }
  return null;
}

/** Trimmed fields of a saved search; the source must be one of the registered modules. */
export function searchFields(input: SearchFieldsInput, sources: readonly JobSource[]): SearchFields {
  const source = input.source.trim().toLowerCase();
  const keywords = input.keywords.trim();
  if (!sources.some((candidate) => candidate.id === source)) {
    throw new ApplicationError('UNKNOWN_SEARCH_SOURCE', `Источник «${input.source}» не подключён.`, 400);
  }
  if (!keywords) throw new ApplicationError('INVALID_SEARCH', 'Укажите ключевые слова поиска.', 400);
  return {
    source, keywords, location: input.location?.trim() || null,
    includeTitle: titleTerms(input.includeTitle), excludeTitle: titleTerms(input.excludeTitle),
  };
}

export function searchQuery(fields: Pick<SearchFields, 'keywords' | 'location'>): SearchQuery {
  return { keywords: fields.keywords, ...(fields.location ? { location: fields.location } : {}) };
}

export type PageCards = Readonly<{ cards: JobCard[]; invalid: number }>;

/** Keeps cards with a valid canonical URL that this run has not seen on earlier pages. */
export function canonicalCards(source: JobSource, page: readonly JobCard[], seenUrls: Set<string>): PageCards {
  const cards: JobCard[] = [];
  let invalid = 0;
  for (const card of page) {
    let url: string;
    try { url = source.canonicalUrl(card.url); } catch { invalid++; continue; }
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    cards.push({ ...card, url });
  }
  return { cards, invalid };
}

/** Random pause between result pages within the limits of the source; `random` is in [0, 1). */
export function pageDelay(source: JobSource, random: number): number {
  const [min, max] = source.limits.pageDelayMs;
  return Math.round(min + (max - min) * random);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
