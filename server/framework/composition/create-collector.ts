import { createPrismaClient } from '../../plugins/database.js';
import { JobRepository } from '../../src/jobs/JobRepository.js';
import { JobService } from '../../src/jobs/JobService.js';
import type { Logger } from '../../src/searches/SearchTypes.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import { createSearchService } from './create-searches.js';

/** The collector writes jobs only through JobService; users are read just to resolve an owner by email. */
export function createCollector(databaseUrl: string, browserSocket: string, log: Logger) {
  const prisma = createPrismaClient(databaseUrl);
  const users = new UserRepository(prisma);
  return {
    searches: createSearchService(prisma, new JobService(new JobRepository(prisma)), { now: () => new Date() }, { log, browserSocket }),
    async activeUserId(email: string): Promise<string | null> {
      const found = await users.findByEmail(email.trim().toLowerCase());
      return found && !found.disabled ? found.user.id : null;
    },
    close: () => prisma.$disconnect(),
  };
}
