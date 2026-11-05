import type { Job as JobRecord, PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Job, JobListQuery, JobPage, JobStatus, NewJob } from './JobService.js';

function toJob(record: JobRecord): Job {
  const { userId: _userId, raw: _raw, redFlags, postedAt, foundAt, updatedAt, ...fields } = record;
  return {
    ...fields,
    redFlags: redFlags ? JSON.parse(redFlags) as string[] : [],
    postedAt: postedAt?.toISOString() ?? null,
    foundAt: foundAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

type JobChange = Readonly<{
  status: JobStatus; score?: number; why?: string | null; redFlags?: string[]; profileRevision?: number | null;
}>;
type TwinCandidate = Readonly<{ id: string; company: string; title: string }>;

/** Every query is scoped to the owner, so another user's job behaves as missing. */
export class JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(ownerId: string, query: JobListQuery & { page: number; limit: number }): Promise<JobPage> {
    const where: Prisma.JobWhereInput = {
      userId: ownerId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.search ? { OR: [{ title: { contains: query.search } }, { company: { contains: query.search } }] } : {}),
    };
    const orderBy: Prisma.JobOrderByWithRelationInput[] = [
      ...(query.sort === 'score' ? [{ score: { sort: 'desc', nulls: 'last' } } as const] : []),
      { foundAt: 'desc' }, { id: 'asc' },
    ];
    const [records, total] = await this.prisma.$transaction([
      this.prisma.job.findMany({ where, orderBy, skip: (query.page - 1) * query.limit, take: query.limit }),
      this.prisma.job.count({ where }),
    ]);
    const items = records.map((record) => {
      const { description: _description, ...summary } = toJob(record);
      return summary;
    });
    return { items, total, page: query.page, limit: query.limit };
  }

  async countByStatus(ownerId: string): Promise<Partial<Record<JobStatus, number>>> {
    const groups = await this.prisma.job.groupBy({ by: ['status'], where: { userId: ownerId }, _count: { _all: true } });
    return Object.fromEntries(groups.map((group) => [group.status, group._count._all]));
  }

  async find(ownerId: string, id: string): Promise<Job | null> {
    const record = await this.prisma.job.findFirst({ where: { id, userId: ownerId } });
    return record ? toJob(record) : null;
  }

  /** Returns null when the owner already has this URL or source ID. */
  async create(ownerId: string, job: NewJob): Promise<Job | null> {
    try {
      return toJob(await this.prisma.job.create({ data: { ...job, userId: ownerId } }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  async existingUrls(ownerId: string, urls: string[]): Promise<string[]> {
    const records = await this.prisma.job.findMany({ where: { userId: ownerId, url: { in: urls } }, select: { url: true } });
    return records.map((record) => record.url);
  }

  /** Applies the change only while the status is still `from`; returns null otherwise. */
  async update(ownerId: string, id: string, from: JobStatus, change: JobChange): Promise<Job | null> {
    const { redFlags, ...fields } = change;
    const { count } = await this.prisma.job.updateMany({
      where: { id, userId: ownerId, status: from },
      data: { ...fields, ...(redFlags ? { redFlags: JSON.stringify(redFlags) } : {}) },
    });
    return count ? this.find(ownerId, id) : null;
  }

  listForScoring(ownerId: string, limit?: number): Promise<Job[]> {
    return this.findJobs({ userId: ownerId, status: 'found', description: { not: null } }, limit);
  }

  listUnsynced(ownerId: string): Promise<Job[]> {
    return this.findJobs({ userId: ownerId, status: 'queued', trackerId: null });
  }

  /**
   * Company and title of jobs that could be a twin: in one of the statuses, rejected with a score, or
   * sent to Job-Tracker. Matching ignores case, so it happens in TS.
   */
  listTwinCandidates(ownerId: string, exceptId: string, statuses: readonly JobStatus[]): Promise<TwinCandidate[]> {
    return this.prisma.job.findMany({
      where: { userId: ownerId, id: { not: exceptId }, OR: [
        { status: { in: [...statuses] } },
        { status: 'rejected', score: { not: null } },
        { trackerId: { not: null } },
      ] },
      select: { id: true, company: true, title: true },
      orderBy: [{ foundAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Sets the Job-Tracker ID only while none is stored; returns null otherwise. */
  async setTrackerId(ownerId: string, id: string, trackerId: string): Promise<Job | null> {
    const { count } = await this.prisma.job.updateMany({ where: { id, userId: ownerId, trackerId: null }, data: { trackerId } });
    return count ? this.find(ownerId, id) : null;
  }

  async findByTrackerId(ownerId: string, trackerId: string): Promise<Job | null> {
    const record = await this.prisma.job.findFirst({ where: { userId: ownerId, trackerId } });
    return record ? toJob(record) : null;
  }

  async findByUrl(ownerId: string, url: string): Promise<Job | null> {
    const record = await this.prisma.job.findFirst({ where: { userId: ownerId, url } });
    return record ? toJob(record) : null;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.job.deleteMany({ where: { id, userId: ownerId } });
    return count > 0;
  }

  /** Oldest first, so a backlog is processed in the order it was found. */
  private async findJobs(where: Prisma.JobWhereInput, limit?: number): Promise<Job[]> {
    const records = await this.prisma.job.findMany({ where, orderBy: [{ foundAt: 'asc' }, { id: 'asc' }], ...(limit ? { take: limit } : {}) });
    return records.map(toJob);
  }
}
