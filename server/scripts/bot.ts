import '../plugins/environment.js';
import { createBot } from '../framework/composition/create-bot.js';
import { defaultBrokerSocket } from '../plugins/browser-broker.js';
import { applySettingsFromEnv, claudeAgentConfigFromEnv, jobTrackerConfigFromEnv, ollamaConfigFromEnv } from '../plugins/environment.js';
import { pause } from '../plugins/http.js';
import { createTelegramClient } from '../plugins/telegram.js';
import { DEFAULT_SCHEDULE_TIMEZONE } from '../src/schedules/ScheduleService.js';
import { realTimer, TelegramBot } from './bot-runtime.js';
import type { ScheduledReportPolicy } from './bot-runtime.js';
import { consoleOutput } from './pipeline-tasks.js';

/**
 * Telegram bot of job-autopilot: one long-lived process (npm run bot, under systemd). It answers only
 * TELEGRAM_CHAT_ID, runs collect / score / cycle / apply in process and keeps the schedules.
 */

function settingsFromEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) throw new Error('Задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env (бот у @BotFather, свой chat id).');
  const chatId = Number(chat);
  if (!Number.isSafeInteger(chatId)) throw new Error('TELEGRAM_CHAT_ID — целое число (id чата).');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан: выполните npm run setup в корне проекта (создаст .env).');
  const policy = process.env.BOT_SCHEDULED_REPORT?.trim() || 'changes';
  if (policy !== 'changes' && policy !== 'always') throw new Error('BOT_SCHEDULED_REPORT — changes или always.');
  return {
    token, chatId, databaseUrl,
    timezone: process.env.SCHEDULE_TIMEZONE?.trim() || DEFAULT_SCHEDULE_TIMEZONE,
    reportPolicy: policy as ScheduledReportPolicy,
    user: process.env.BOT_USER?.trim() || null,
  };
}

async function main(): Promise<void> {
  const settings = settingsFromEnv();
  const app = createBot({
    databaseUrl: settings.databaseUrl,
    browserSocket: process.env.AGENT_BROWSER_SOCKET || defaultBrokerSocket,
    ollama: ollamaConfigFromEnv(),
    tracker: jobTrackerConfigFromEnv(),
    timezone: settings.timezone,
    log: { info: consoleOutput.line, warn: consoleOutput.warn },
    agentConfig: () => claudeAgentConfigFromEnv(),
    apply: applySettingsFromEnv(),
  });
  const shutdown = new AbortController();
  try {
    const owner = await app.resolveOwner(settings.user);
    const interrupted = await app.schedules.failInterrupted(owner);
    if (interrupted) consoleOutput.warn(`Незавершённых запусков после прошлой остановки: ${interrupted} (помечены как ошибка).`);

    const bot = new TelegramBot(createTelegramClient({ token: settings.token }), owner, app, {
      chatId: settings.chatId, timezone: settings.timezone, reportPolicy: settings.reportPolicy,
    }, { now: () => new Date(), timer: realTimer, out: consoleOutput });

    const stop = (signal: string) => {
      if (shutdown.signal.aborted) return;
      consoleOutput.warn(`${signal}: останавливаю бота, текущая задача дописывает шаг…`);
      bot.scheduler.stop();
      bot.runner.stop();
      shutdown.abort();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));

    await bot.registerCommands();
    await bot.scheduler.refresh();
    const next = bot.scheduler.nextAt;
    console.log(`Бот запущен для ${owner.email}; чат ${settings.chatId}; ближайший запуск по расписанию: ${next ? next.toISOString() : 'нет'}.`);
    await bot.poll(shutdown.signal, pause);
    await bot.settled();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Бот завершился ошибкой.');
  process.exitCode = 1;
});
