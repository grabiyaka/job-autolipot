import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Clock, Identifiers } from '../core/runtime.js';
import { UserService } from '../../src/users/UserService.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import type { UserApi } from '../../src/users/UserTypes.js';
import { JobService } from '../../src/jobs/JobService.js';
import { JobRepository } from '../../src/jobs/JobRepository.js';
import type { SearchService } from '../../src/searches/SearchService.js';
import { ScryptPasswords } from '../../plugins/passwords.js';
import { defaultBrokerSocket } from '../../plugins/browser-broker.js';
import { createSearchService } from './create-searches.js';

export interface Application {
  users: UserApi;
  jobs: JobService;
  searches: SearchService;
}

// Only the composition root knows concrete repositories. HTTP receives public APIs.
export function createApplication(prisma: PrismaClient, clock: Clock, identifiers: Identifiers, sessionTtlSeconds = 3600): Application {
  const users = new UserService(new UserRepository(prisma), new ScryptPasswords(), clock, identifiers, sessionTtlSeconds);
  const jobs = new JobService(new JobRepository(prisma));
  // HTTP only manages saved searches; runs belong to the collector CLI, so the run log stays silent.
  const searches = createSearchService(prisma, jobs, clock, { log: { info: () => {}, warn: () => {} }, browserSocket: defaultBrokerSocket });
  return { users, jobs, searches };
}
