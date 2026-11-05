import type { Actor } from '../core/actor.js';
import { acquireBrowserLock } from '../../plugins/browser-lock.js';
import { cronCalendar } from '../../plugins/cron.js';
import { createPrismaClient } from '../../plugins/database.js';
import type { JobTrackerConfig } from '../../plugins/job-tracker.js';
import type { OllamaConfig } from '../../plugins/ollama.js';
import { AnswerRepository } from '../../src/answers/AnswerRepository.js';
import { AnswerService } from '../../src/answers/AnswerService.js';
import { JobRepository } from '../../src/jobs/JobRepository.js';
import { JobService } from '../../src/jobs/JobService.js';
import { ScheduleRepository } from '../../src/schedules/ScheduleRepository.js';
import { ScheduleService } from '../../src/schedules/ScheduleService.js';
import type { Logger } from '../../src/searches/SearchTypes.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import { createCollector } from './create-collector.js';
import { createScorer } from './create-scorer.js';
import { createSearchService } from './create-searches.js';
import type { ClaudeAgentConfig } from '../../plugins/claude-agent.js';
import type { ApplyEnvSettings } from '../../plugins/environment.js';
import { createJobTrackerClient } from '../../plugins/job-tracker.js';
import { applyBrowserLock, applySettings, claudeApplyAgent, createApplicationService } from './create-applications.js';

export type BotSettings = Readonly<{
  databaseUrl: string;
  browserSocket: string;
  ollama: OllamaConfig;
  tracker: JobTrackerConfig | null;
  /** Time zone of new schedules (SCHEDULE_TIMEZONE). */
  timezone: string;
  log: Logger;
  /** Read on the first agent run, so the bot starts without DeepSeek prices; apply then reports the error. */
  agentConfig: () => ClaudeAgentConfig;
  apply: ApplyEnvSettings;
}>;

export type BotOwner = Actor & Readonly<{ email: string }>;

/**
 * The Telegram bot: the same services as HTTP and the CLI, acting as one owner. Pipeline tasks get
 * their own collector and scorer per run (as the CLI does), closed when the run ends.
 */
export function createBot(settings: BotSettings) {
  const prisma = createPrismaClient(settings.databaseUrl);
  const users = new UserRepository(prisma);
  const clock = { now: () => new Date() };
  const jobs = new JobService(new JobRepository(prisma));
  const answers = new AnswerService(new AnswerRepository(prisma));
  const applications = createApplicationService(prisma, {
    jobs, answers,
    users: { async profile(userId) { const found = await users.findById(userId); return found && !found.disabled ? found.user : null; } },
    tracker: settings.tracker ? createJobTrackerClient(settings.tracker) : null,
    agent: claudeApplyAgent(settings.agentConfig),
    browser: applyBrowserLock,
    settings: applySettings(settings.apply),
    clock,
  });
  return {
    jobs,
    searches: createSearchService(prisma, jobs, clock, { log: settings.log, browserSocket: settings.browserSocket }),
    answers,
    applications,
    schedules: new ScheduleService(new ScheduleRepository(prisma), cronCalendar, clock, { timezone: settings.timezone }),
    pipeline: {
      trackerConfigured: settings.tracker !== null,
      lockBrowser: (task: string) => acquireBrowserLock({ task: `bot:${task}` }),
      openCollector: (log: Logger = settings.log) => createCollector(settings.databaseUrl, settings.browserSocket, log),
      openScorer: () => createScorer(settings.databaseUrl, { ollama: settings.ollama, tracker: settings.tracker }),
    },
    /**
     * The owner the bot acts for: BOT_USER when it is set, otherwise the only active user.
     * Several active users without BOT_USER are an error — the bot must not guess.
     */
    async resolveOwner(email: string | null): Promise<BotOwner> {
      if (email) {
        const found = await users.findByEmail(email.trim().toLowerCase());
        if (!found || found.disabled) throw new Error(`BOT_USER: активный пользователь ${email} не найден.`);
        return { id: found.user.id, role: found.user.role, email: found.user.email };
      }
      const active = await prisma.user.findMany({ where: { disabled: false }, select: { id: true, role: true, email: true }, take: 2 });
      if (active.length === 1) return active[0]!;
      throw new Error(active.length
        ? 'Активных пользователей несколько: укажите BOT_USER=<email> в .env.'
        : 'Активных пользователей нет: создайте его (npm run user:create) или укажите BOT_USER.');
    },
    close: () => prisma.$disconnect(),
  };
}
