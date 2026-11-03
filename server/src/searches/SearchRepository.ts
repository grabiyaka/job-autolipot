import type { PrismaClient, Search as SearchRecord, SearchRun as SearchRunRecord } from '../../generated/prisma/client.js';
import type { NewSearchRun, OwnedSearch, Search, SearchRun } from './SearchService.js';

const terms = (value: string | null): string[] => (value ? JSON.parse(value) as string[] : []);
const termsColumn = (value: readonly string[]): string | null => (value.length ? JSON.stringify(value) : null);

function toSearch(record: SearchRecord): Search {
  const { userId: _userId, includeTitle, excludeTitle, createdAt, updatedAt, ...fields } = record;
  return {
    ...fields, includeTitle: terms(includeTitle), excludeTitle: terms(excludeTitle),
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
  };
}

function changeColumns(data: Omit<SearchData, 'source'>) {
  const { includeTitle, excludeTitle, ...fields } = data;
  return { ...fields, includeTitle: termsColumn(includeTitle), excludeTitle: termsColumn(excludeTitle) };
}

function toRun(record: SearchRunRecord): SearchRun {
  const { searchId: _searchId, startedAt, finishedAt, ...fields } = record;
  return { ...fields, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
}

type SearchData = Readonly<{
  source: string; keywords: string; location: string | null;
  includeTitle: readonly string[]; excludeTitle: readonly string[]; enabled: boolean;
}>;

/** Owner-facing queries are scoped to the owner, so another user's search behaves as missing. */
export class SearchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(ownerId: string): Promise<Search[]> {
    const records = await this.prisma.search.findMany({ where: { userId: ownerId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return records.map(toSearch);
  }

  /** Enabled searches of active users; one owner when `ownerId` is given. */
  async listEnabled(ownerId?: string): Promise<OwnedSearch[]> {
    const records = await this.prisma.search.findMany({
      where: { enabled: true, user: { disabled: false }, ...(ownerId ? { userId: ownerId } : {}) },
      orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return records.map((record) => ({ ...toSearch(record), ownerId: record.userId }));
  }

  async find(ownerId: string, id: string): Promise<Search | null> {
    const record = await this.prisma.search.findFirst({ where: { id, userId: ownerId } });
    return record ? toSearch(record) : null;
  }

  async create(ownerId: string, data: SearchData): Promise<Search> {
    return toSearch(await this.prisma.search.create({
      data: {
        userId: ownerId, source: data.source, keywords: data.keywords, location: data.location, enabled: data.enabled,
        includeTitle: termsColumn(data.includeTitle), excludeTitle: termsColumn(data.excludeTitle),
      },
    }));
  }

  async update(ownerId: string, id: string, data: Omit<SearchData, 'source'>): Promise<Search | null> {
    const { count } = await this.prisma.search.updateMany({ where: { id, userId: ownerId }, data: changeColumns(data) });
    return count ? this.find(ownerId, id) : null;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.search.deleteMany({ where: { id, userId: ownerId } });
    return count > 0;
  }

  async recordRun(run: NewSearchRun): Promise<void> {
    await this.prisma.searchRun.create({ data: run });
  }

  /** Newest first; the caller has already checked that the search belongs to the owner. */
  async runs(searchId: string, limit: number): Promise<SearchRun[]> {
    const records = await this.prisma.searchRun.findMany({
      where: { searchId }, orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: limit,
    });
    return records.map(toRun);
  }
}
