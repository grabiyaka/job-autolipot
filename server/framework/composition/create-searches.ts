import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Clock } from '../core/runtime.js';
import { createBrokerBrowser } from '../../plugins/browser-broker.js';
import { createHttpClient, pause } from '../../plugins/http.js';
import type { JobPipelineApi } from '../../src/jobs/JobTypes.js';
import { SearchRepository } from '../../src/searches/SearchRepository.js';
import { SearchService } from '../../src/searches/SearchService.js';
import { searchSources } from '../../src/searches/SearchSources.js';
import type { Logger } from '../../src/searches/SearchTypes.js';

export type SearchSettings = Readonly<{ log: Logger; browserSocket: string }>;

/**
 * The same SearchService serves HTTP (saved searches) and the collector CLI (runs).
 * Neither client connects until a run needs it, so building the service is free.
 */
export function createSearchService(prisma: PrismaClient, jobs: JobPipelineApi, clock: Clock, settings: SearchSettings): SearchService {
  const http = createHttpClient({ userAgent: 'job-autopilot/0.1 (personal job search)', timeoutMs: 30_000, retries: 2, pause });
  const browser = createBrokerBrowser({ socketPath: settings.browserSocket });
  return new SearchService(new SearchRepository(prisma), jobs, searchSources, { http, browser, log: settings.log, pause, random: Math.random }, clock);
}
