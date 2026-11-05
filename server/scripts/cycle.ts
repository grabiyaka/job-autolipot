import '../plugins/environment.js';
import { parseArgs } from 'node:util';
import { createCollector } from '../framework/composition/create-collector.js';
import { createScorer } from '../framework/composition/create-scorer.js';
import { defaultBrokerSocket } from '../plugins/browser-broker.js';
import { acquireBrowserLock } from '../plugins/browser-lock.js';
import { jobTrackerConfigFromEnv, ollamaConfigFromEnv } from '../plugins/environment.js';
import { SCORE_THRESHOLD } from '../src/scoring/ScoringRules.js';
import type { Logger } from '../src/searches/SearchTypes.js';
import { adHocSearch, collectOptions, cycleSummaryLines, maxMinutes, scoreOptions, scoreSettings } from './pipeline-cli.js';
import { consoleOutput, runCycle } from './pipeline-tasks.js';

const usage = `Один прогон конвейера: сбор вакансий → оценка found моделью → отправка queued в Job-Tracker.

  npm run cycle -- [--user me@example.com] [--dry-run] [--no-push] [--skip-collect] [--max-minutes 60]
                   [--model NAME] [--threshold N] [--limit N]
  npm run cycle -- --user me@example.com --source linkedin --query "node.js" [--location Remote]
                   [--include "node,typescript"] [--exclude "java,qa"] [другие флаги выше]
  npm run cycle -- … --easy-apply   только вакансии с LinkedIn Easy Apply (как в npm run collect)

  --user          только этот пользователь (сбор и отбор); без него — все активные
  --source/--query/--location/--include/--exclude
                  разовый поиск вместо сохранённых, как в npm run collect (нужны --user, --source, --query)
  --skip-collect  без сбора: только оценка уже найденных (found) и отправка
  --dry-run       сбор и оценка без записи; в Job-Tracker ничего не уходит
  --no-push       оценить, но не отправлять queued в Job-Tracker
  --max-minutes   общий предел на весь прогон (по умолчанию 60); что не потратил сбор, достаётся отбору
  --model         модель Ollama; по умолчанию OLLAMA_MODEL
  --threshold     с какой оценки вакансия идёт в queued; по умолчанию ${SCORE_THRESHOLD}
  --limit         не больше N вакансий на пользователя при оценке (самые старые found)

Отбор берёт все found, включая оставшиеся с прошлых прогонов. Брокер браузера недоступен или браузер
занят другой задачей (подача, бот) — сбор пропускается, отбор идёт. Ollama недоступна — отбор останавливается (код выхода 1).
Ctrl+C дописывает текущую страницу или вакансию, останавливает этап; следующие этапы не запускаются.`;

const log: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`! ${message}`),
};

const print = (lines: readonly string[]) => console.log(lines.join('\n'));

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { ...collectOptions, ...scoreOptions, 'skip-collect': { type: 'boolean' } } });
  if (values.help) { console.log(usage); return; }
  let adHoc: ReturnType<typeof adHocSearch>;
  try { adHoc = adHocSearch(values); } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\n\n${usage}`); }
  const skipCollect = values['skip-collect'] ?? false;
  if (skipCollect && adHoc) throw new Error('--skip-collect нельзя сочетать с флагами разового поиска.');
  const minutes = maxMinutes(values['max-minutes']);
  const { dryRun, push, ...tuning } = scoreSettings(values);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан: выполните npm run setup в корне проекта (создаст .env).');
  const tracker = jobTrackerConfigFromEnv();

  const interrupt = new AbortController();
  process.once('SIGINT', () => { log.warn('Остановка по Ctrl+C: дописываю текущий шаг, следующие этапы не запускаются…'); interrupt.abort(); });
  const deadline = AbortSignal.timeout(minutes * 60_000);
  const signal = AbortSignal.any([interrupt.signal, deadline]);
  const stopped = () => (interrupt.signal.aborted ? 'остановлено по Ctrl+C' : deadline.aborted ? 'истёк --max-minutes' : null);

  const scorer = createScorer(databaseUrl, { ollama: ollamaConfigFromEnv(), tracker });
  try {
    let owner: { id: string; email: string } | null = null;
    if (values.user) {
      owner = await scorer.activeUser(values.user);
      if (!owner) throw new Error(`Активный пользователь ${values.user} не найден. Создайте его: npm run user:create -- --email ${values.user} --name …`);
    }

    const result = await runCycle({
      owner, adHoc, skipCollect, easyApplyOnly: values['easy-apply'] ?? false,
      score: { ...tuning, dryRun, push }, signal, stopped, trackerConfigured: tracker !== null,
      lockBrowser: () => acquireBrowserLock({ task: 'cycle' }),
      openCollector: () => createCollector(databaseUrl, process.env.AGENT_BROWSER_SOCKET || defaultBrokerSocket, log),
      scorer, activeUsers: () => scorer.activeUsers(),
    }, consoleOutput);
    if (result.failed) process.exitCode = 1;

    print(['', ...cycleSummaryLines(result.collect, result.score)]);
  } finally { await scorer.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Цикл завершился ошибкой.');
  process.exitCode = 1;
});
