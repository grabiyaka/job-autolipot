import type { PrismaClient } from '../../generated/prisma/client.js';
import type { StoredTrackerProfile } from './TrackerService.js';

/** The owner's last copy of the JT profile; one row per user. */
export class TrackerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findProfile(ownerId: string): Promise<StoredTrackerProfile | null> {
    const record = await this.prisma.trackerProfile.findUnique({ where: { userId: ownerId } });
    return record && { revision: record.revision, etag: record.etag, markdown: record.markdown, fetchedAt: record.fetchedAt };
  }

  async saveProfile(ownerId: string, profile: StoredTrackerProfile): Promise<void> {
    await this.prisma.trackerProfile.upsert({ where: { userId: ownerId }, create: { userId: ownerId, ...profile }, update: profile });
  }

  /** JT confirmed the stored copy is current. */
  async touchProfile(ownerId: string, fetchedAt: Date): Promise<void> {
    await this.prisma.trackerProfile.updateMany({ where: { userId: ownerId }, data: { fetchedAt } });
  }
}
