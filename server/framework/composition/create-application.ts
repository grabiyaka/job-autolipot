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
import type { TrackerService } from '../../src/trackers/TrackerService.js';
import type { JobTrackerClient } from '../../src/trackers/TrackerTypes.js';
import { createTrackerService } from './create-trackers.js';
import { AnswerService } from '../../src/answers/AnswerService.js';
import { AnswerRepository } from '../../src/answers/AnswerRepository.js';
import type { ApplicationService } from '../../src/applications/ApplicationService.js';
import type { ApplyAgent, ApplySettings } from '../../src/applications/ApplicationContracts.js';
import { applyBrowserLock, createApplicationService } from './create-applications.js';

export interface Application {
  users: UserApi;
  jobs: JobService;
  searches: SearchService;
  trackers: TrackerService;
  answers: AnswerService;
  applications: ApplicationService;
}

/** Applying over HTTP: without an agent, submit answers 503 and only reading and answering questions work. */
export type HttpApplySettings = Readonly<{ agent: ApplyAgent | null; settings: ApplySettings }>;
const noApply: HttpApplySettings = { agent: null, settings: { cvPath: null, maxPerRun: 5, maxMicrosPerDay: 500_000, autoSubmit: false } };

// Only the composition root knows concrete repositories. HTTP receives public APIs.
export function createApplication(prisma: PrismaClient, clock: Clock, identifiers: Identifiers, sessionTtlSeconds = 3600,
  tracker: JobTrackerClient | null = null, apply: HttpApplySettings = noApply,
): Application {
  const users = new UserService(new UserRepository(prisma), new ScryptPasswords(), clock, identifiers, sessionTtlSeconds);
  const jobs = new JobService(new JobRepository(prisma));
  // HTTP only manages saved searches; runs belong to the collector CLI, so the run log stays silent.
  const searches = createSearchService(prisma, jobs, clock, { log: { info: () => {}, warn: () => {} }, browserSocket: defaultBrokerSocket });
  const trackers = createTrackerService(prisma, tracker, jobs, users, clock);
  const answers = new AnswerService(new AnswerRepository(prisma));
  const applications = createApplicationService(prisma, {
    jobs, answers, users, tracker, agent: apply.agent, browser: applyBrowserLock, settings: apply.settings, clock,
  });
  return { users, jobs, searches, trackers, answers, applications };
}
