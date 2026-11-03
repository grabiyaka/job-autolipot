import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Clock, Identifiers } from '../core/runtime.js';
import { UserService } from '../../src/users/UserService.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import type { UserApi } from '../../src/users/UserTypes.js';
import { JobService } from '../../src/jobs/JobService.js';
import { JobRepository } from '../../src/jobs/JobRepository.js';
import { ScryptPasswords } from '../../plugins/passwords.js';

export interface Application {
  users: UserApi;
  jobs: JobService;
}

// Only the composition root knows concrete repositories. HTTP receives public APIs.
export function createApplication(prisma: PrismaClient, clock: Clock, identifiers: Identifiers, sessionTtlSeconds = 3600): Application {
  const users = new UserService(new UserRepository(prisma), new ScryptPasswords(), clock, identifiers, sessionTtlSeconds);
  const jobs = new JobService(new JobRepository(prisma));
  return { users, jobs };
}
