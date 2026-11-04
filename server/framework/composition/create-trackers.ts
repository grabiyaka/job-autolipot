import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Clock } from '../core/runtime.js';
import type { JobPipelineApi } from '../../src/jobs/JobTypes.js';
import { TrackerRepository } from '../../src/trackers/TrackerRepository.js';
import { TrackerService } from '../../src/trackers/TrackerService.js';
import type { JobTrackerClient } from '../../src/trackers/TrackerTypes.js';
import type { UserApi } from '../../src/users/UserTypes.js';

/** `client` is null when JOB_TRACKER_URL/JOB_TRACKER_TOKEN are unset: the domain then answers "not configured". */
export function createTrackerService(
  prisma: PrismaClient, client: JobTrackerClient | null, jobs: JobPipelineApi, users: Pick<UserApi, 'profile'>, clock: Clock,
): TrackerService {
  return new TrackerService(new TrackerRepository(prisma), client, jobs, users, clock);
}
