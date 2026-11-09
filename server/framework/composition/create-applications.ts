import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Actor } from '../core/actor.js';
import type { Clock } from '../core/runtime.js';
import { agentFilesDir } from '../../plugins/agent-guard-rules.js';
import { acquireBrowserLock } from '../../plugins/browser-lock.js';
import { AgentError, AgentUnavailableError, agentUploadPath, createClaudeAgent } from '../../plugins/claude-agent.js';
import type { ClaudeAgent, ClaudeAgentConfig } from '../../plugins/claude-agent.js';
import { createPrismaClient } from '../../plugins/database.js';
import type { ApplyEnvSettings } from '../../plugins/environment.js';
import { createJobTrackerClient } from '../../plugins/job-tracker.js';
import type { JobTrackerConfig } from '../../plugins/job-tracker.js';
import { AnswerRepository } from '../../src/answers/AnswerRepository.js';
import { AnswerService } from '../../src/answers/AnswerService.js';
import { ApplyAgentError } from '../../src/applications/ApplicationContracts.js';
import type { ApplyAgent, ApplyBrowser, ApplySettings } from '../../src/applications/ApplicationContracts.js';
import { ApplicationRepository } from '../../src/applications/ApplicationRepository.js';
import { ApplicationService } from '../../src/applications/ApplicationService.js';
import { usdToMicros } from '../../src/applications/ApplicationRules.js';
import { JobRepository } from '../../src/jobs/JobRepository.js';
import { JobService } from '../../src/jobs/JobService.js';
import type { JobTrackerClient } from '../../src/trackers/TrackerTypes.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import type { UserApi } from '../../src/users/UserTypes.js';
import { createTrackerService } from './create-trackers.js';

const noSpend = { tokens: { input: 0, cacheRead: 0, output: 0 }, costMicros: 0 };

/**
 * The claude-agent plugin as the domain's ApplyAgent. The config is read on the first run, so a process
 * without DeepSeek prices (HTTP, the bot) still starts; the run then fails as "agent unavailable".
 */
export function claudeApplyAgent(config: () => ClaudeAgentConfig): ApplyAgent {
  let agent: ClaudeAgent | null = null;
  return {
    async run(request) {
      try {
        agent ??= createClaudeAgent(config());
      } catch (error) {
        throw new ApplyAgentError((error as Error).message, noSpend, { unavailable: true });
      }
      try {
        const result = await agent.run(request);
        return {
          output: result.output, sessionId: result.sessionId, turns: result.turns, durationMs: result.durationMs,
          tokens: result.tokens, costMicros: result.costMicros, runDir: result.runDir, screenshots: result.screenshots,
          toolCalls: result.guardLog.map((entry) => ({
            tool: entry.tool, decision: entry.decision, ...(entry.reason ? { reason: entry.reason } : {}),
            ...(entry.submit !== undefined ? { submit: entry.submit } : {}),
          })),
        };
      } catch (error) {
        if (error instanceof AgentError) {
          throw new ApplyAgentError(error.message, { tokens: error.tokens ?? noSpend.tokens, costMicros: error.costMicros ?? 0 }, {
            ...(error.sessionId ? { sessionId: error.sessionId } : {}), ...(error.runDir ? { runDir: error.runDir } : {}),
            screenshots: error.screenshots,
            toolCalls: error.guardLog.map((entry) => ({ tool: entry.tool, decision: entry.decision, ...(entry.submit !== undefined ? { submit: entry.submit } : {}) })),
            unavailable: error instanceof AgentUnavailableError,
          });
        }
        // The plugin rethrows the signal's reason on a stop.
        if (request.signal?.aborted) throw new ApplyAgentError('Запуск агента остановлен', noSpend, { aborted: true });
        throw error;
      }
    },
  };
}

/** The browser lock file shared with the collector and the bot. */
export const applyBrowserLock: ApplyBrowser = {
  acquire: (task) => acquireBrowserLock({ task }),
};

/** APPLY_CV_FILE, or the only PDF at the top of /srv/agent-files; null when it cannot be told. */
export function resolveCvPath(settings: ApplyEnvSettings, filesDir: string = agentFilesDir): string | null {
  let file = settings.cvFile;
  if (!file) {
    let pdfs: string[];
    try {
      pdfs = readdirSync(filesDir, { withFileTypes: true }).filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf').map((entry) => entry.name);
    } catch {
      return null;
    }
    if (pdfs.length !== 1) return null;
    file = pdfs[0]!;
  }
  return agentUploadPath(file, settings.agentCwd);
}

export function applySettings(settings: ApplyEnvSettings): ApplySettings {
  return {
    cvPath: resolveCvPath(settings), maxPerRun: settings.maxPerRun, maxMicrosPerDay: usdToMicros(settings.maxUsdPerDay), autoSubmit: settings.autoSubmit,
  };
}

export type ApplyDependencies = Readonly<{
  jobs: JobService;
  answers: AnswerService;
  users: Pick<UserApi, 'profile'>;
  tracker: JobTrackerClient | null;
  agent: ApplyAgent | null;
  browser: ApplyBrowser;
  settings: ApplySettings;
  clock: Clock;
}>;

export function createApplicationService(prisma: PrismaClient, deps: ApplyDependencies): ApplicationService {
  const trackers = createTrackerService(prisma, deps.tracker, deps.jobs, deps.users, deps.clock);
  return new ApplicationService(new ApplicationRepository(prisma), deps.jobs, trackers, deps.answers, deps.agent, deps.browser, deps.clock, deps.settings);
}

export type ApplyProcessSettings = Readonly<{
  tracker: JobTrackerConfig | null;
  agentConfig: () => ClaudeAgentConfig;
  apply: ApplyEnvSettings;
}>;

/** One ApplicationService on its own Prisma client: the apply CLI and the bot. */
export function createApplier(databaseUrl: string, settings: ApplyProcessSettings) {
  const prisma = createPrismaClient(databaseUrl);
  const users = new UserRepository(prisma);
  const clock = { now: () => new Date() };
  const applications = createApplicationService(prisma, {
    jobs: new JobService(new JobRepository(prisma)),
    answers: new AnswerService(new AnswerRepository(prisma)),
    users: { async profile(userId) { const found = await users.findById(userId); return found && !found.disabled ? found.user : null; } },
    tracker: settings.tracker ? createJobTrackerClient(settings.tracker) : null,
    agent: claudeApplyAgent(settings.agentConfig),
    browser: applyBrowserLock,
    settings: applySettings(settings.apply),
    clock,
  });
  return {
    applications,
    /** The user by email, or the only active user when email is null; throws when it cannot be told. */
    async activeUser(email: string | null): Promise<Actor & { email: string }> {
      if (email) {
        const found = await users.findByEmail(email.trim().toLowerCase());
        if (!found || found.disabled) throw new Error(`Активный пользователь ${email} не найден.`);
        return { id: found.user.id, role: found.user.role, email: found.user.email };
      }
      const active = await prisma.user.findMany({ where: { disabled: false }, select: { id: true, role: true, email: true }, take: 2 });
      if (active.length === 1) return active[0]!;
      throw new Error(active.length ? 'Активных пользователей несколько: укажите --user или BOT_USER.' : 'Активных пользователей нет: npm run user:create.');
    },
    close: () => prisma.$disconnect(),
  };
}
