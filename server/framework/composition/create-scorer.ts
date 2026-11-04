import { createPrismaClient } from '../../plugins/database.js';
import { createJobTrackerClient } from '../../plugins/job-tracker.js';
import type { JobTrackerConfig } from '../../plugins/job-tracker.js';
import { createOllamaClient, OllamaHttpError, OllamaUnavailableError } from '../../plugins/ollama.js';
import type { OllamaClient, OllamaConfig } from '../../plugins/ollama.js';
import { JobRepository } from '../../src/jobs/JobRepository.js';
import { JobService } from '../../src/jobs/JobService.js';
import { ScoringModelUnavailableError } from '../../src/scoring/ScoringContracts.js';
import type { ScoringModel } from '../../src/scoring/ScoringContracts.js';
import { ScoringService } from '../../src/scoring/ScoringService.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import type { UserApi } from '../../src/users/UserTypes.js';
import { createTrackerService } from './create-trackers.js';

/**
 * The Ollama plugin as the scoring model. A server that is down, a timeout and an HTTP error
 * (most often "model not found") make every next request fail too, so all of them stop the run.
 */
export function ollamaScoringModel(ollama: OllamaClient): ScoringModel {
  return {
    defaultModel: ollama.config.model,
    async chatJson(request, parse) {
      try {
        return await ollama.chatJson(request, parse);
      } catch (error) {
        if (error instanceof OllamaUnavailableError || error instanceof OllamaHttpError) {
          throw new ScoringModelUnavailableError(error.message);
        }
        throw error;
      }
    },
  };
}

export type ScorerSettings = Readonly<{ ollama: OllamaConfig; tracker: JobTrackerConfig | null }>;

/** The scorer reads and decides jobs only through JobService and reaches Job-Tracker through TrackerService. */
export function createScorer(databaseUrl: string, settings: ScorerSettings) {
  const prisma = createPrismaClient(databaseUrl);
  const users = new UserRepository(prisma);
  const userProfiles: Pick<UserApi, 'profile'> = {
    async profile(userId) {
      const found = await users.findById(userId);
      return found && !found.disabled ? found.user : null;
    },
  };
  const jobs = new JobService(new JobRepository(prisma));
  const client = settings.tracker ? createJobTrackerClient(settings.tracker) : null;
  const trackers = createTrackerService(prisma, client, jobs, userProfiles, { now: () => new Date() });
  return {
    scoring: new ScoringService(jobs, trackers, ollamaScoringModel(createOllamaClient(settings.ollama))),
    trackerConfigured: client !== null,
    async activeUser(email: string): Promise<Readonly<{ id: string; email: string }> | null> {
      const found = await users.findByEmail(email.trim().toLowerCase());
      return found && !found.disabled ? { id: found.user.id, email: found.user.email } : null;
    },
    activeUsers: (): Promise<{ id: string; email: string }[]> =>
      prisma.user.findMany({ where: { disabled: false }, select: { id: true, email: true }, orderBy: { createdAt: 'asc' } }),
    close: () => prisma.$disconnect(),
  };
}
