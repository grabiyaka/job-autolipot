import '../plugins/environment.js';
import { parseArgs } from 'node:util';
import { createHunter } from '../framework/composition/create-hunter.js';
import { createScorer } from '../framework/composition/create-scorer.js';
import { acquireBrowserLock } from '../plugins/browser-lock.js';
import { huntAgentConfigFromEnv, huntSettingsFromEnv, jobTrackerConfigFromEnv, ollamaConfigFromEnv } from '../plugins/environment.js';
import { agentSites } from '../src/searches/AgentSites.js';
import { SCORE_THRESHOLD } from '../src/scoring/ScoringRules.js';
import type { Logger } from '../src/searches/SearchTypes.js';
import { adHocHunt, huntLimit, huntOptions, huntSummaryLines, maxMinutes, scoreSettings } from './pipeline-cli.js';
import { consoleOutput, runHunt } from './pipeline-tasks.js';

const usage = `Сбор с других бирж через агента Claude (подписка, HUNT_MODEL) → оценка found → отправка queued в Job-Tracker.

Сохранённые поиски через агента (source agent, /search @indeed … в боте; отчёт — в search_runs):
  npm run hunt -- [--user me@example.com] [--limit 10] [--dry-run] [--no-push] [--skip-score] [--max-minutes 60]
                  [--threshold N] [--model NAME]

Разовый поиск (о самом поиске ничего не сохраняется):
  npm run hunt -- --user me@example.com --site djinni --query "node.js" [--location Remote]
                  [--include "node,typescript"] [--exclude "java,qa"] [флаги выше]

  --site        ${agentSites.map((site) => site.id).join(', ')} или https-адрес страницы поиска другой биржи
  --limit       описаний новых вакансий на поиск (1–50, по умолчанию 10); остальные новые — в следующий прогон
  --dry-run     агент работает (и тратит), но ничего не записывается; в Job-Tracker ничего не уходит
  --skip-score  только сбор через агента, без оценки и отправки
  --no-push     оценить, но не отправлять queued в Job-Tracker
  --threshold / --model   как в npm run cycle (порог по умолчанию ${SCORE_THRESHOLD}, модель Ollama)
  --max-minutes предел всего прогона (по умолчанию 60)

Агент только читает: хук-защита в режиме browse пускает лишь на хосты сайта, запрещает Apply/Sign in/…,
Enter и ввод вне поля поиска. Капча, Cloudflare или вход — поиск останавливается, остальные поиски этого
сайта в прогоне пропускаются. Пределы: HUNT_MAX_USD_PER_DAY (по умолчанию 5, цены Claude), HUNT_TIMEOUT_MS на запуск
агента (8 мин). Браузер занят другой задачей — прогон не начинается.`;

const log: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`! ${message}`),
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: huntOptions });
  if (values.help) { console.log(usage); return; }
  let adHoc: ReturnType<typeof adHocHunt>;
  try { adHoc = adHocHunt(values); } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\n\n${usage}`); }
  const limit = huntLimit(values.limit);
  const minutes = maxMinutes(values['max-minutes']);
  const { dryRun, push, ...tuning } = scoreSettings({ ...values, limit: undefined });
  const skipScore = values['skip-score'] ?? false;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан: выполните npm run setup в корне проекта (создаст .env).');
  const tracker = jobTrackerConfigFromEnv();
  const hunt = huntSettingsFromEnv();

  const interrupt = new AbortController();
  process.once('SIGINT', () => { log.warn('Остановка по Ctrl+C: агент останавливается, следующие этапы не запускаются…'); interrupt.abort(); });
  const deadline = AbortSignal.timeout(minutes * 60_000);
  const signal = AbortSignal.any([interrupt.signal, deadline]);
  const stopped = () => (interrupt.signal.aborted ? 'остановлено по Ctrl+C' : deadline.aborted ? 'истёк --max-minutes' : null);

  // Throws «браузер занят: …» when another task of this app holds the agent Chromium; held for the whole hunt.
  const lock = acquireBrowserLock({ task: 'hunt' });
  const scorer = createScorer(databaseUrl, { ollama: ollamaConfigFromEnv(), tracker });
  try {
    let owner: { id: string; email: string } | null = null;
    if (values.user) {
      owner = await scorer.activeUser(values.user);
      if (!owner) throw new Error(`Активный пользователь ${values.user} не найден. Создайте его: npm run user:create -- --email ${values.user} --name …`);
    }
    const result = await runHunt({
      owner, adHoc, skipScore, score: { ...tuning, dryRun, push }, signal, stopped, trackerConfigured: tracker !== null,
      ...(limit !== undefined ? { limit } : {}),
      openHunter: () => createHunter(databaseUrl, { log, agentConfig: () => huntAgentConfigFromEnv(), hunt }),
      scorer, activeUsers: () => scorer.activeUsers(),
    }, consoleOutput);
    if (result.failed) process.exitCode = 1;
    console.log(['', ...huntSummaryLines(result.hunt, result.score)].join('\n'));
  } finally {
    try { await scorer.close(); } finally { lock.release(); }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Сбор через агента завершился ошибкой.');
  process.exitCode = 1;
});
