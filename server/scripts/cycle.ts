import '../plugins/environment.js';
import { parseArgs } from 'node:util';
import { createCollector } from '../framework/composition/create-collector.js';
import { createScorer } from '../framework/composition/create-scorer.js';
import { defaultBrokerSocket } from '../plugins/browser-broker.js';
import { jobTrackerConfigFromEnv, ollamaConfigFromEnv } from '../plugins/environment.js';
import { SCORE_THRESHOLD } from '../src/scoring/ScoringRules.js';
import type { ScoringReport } from '../src/scoring/ScoringService.js';
import type { SearchRunReport } from '../src/searches/SearchService.js';
import { BrowserError } from '../src/searches/SearchTypes.js';
import type { Logger } from '../src/searches/SearchTypes.js';
import {
  adHocSearch, collectOptions, cycleSummaryLines, maxMinutes, profileSkip, scoreOptions, scoreSettings,
  scoringLine, scoringSummaryLines, searchReportLines,
} from './pipeline-cli.js';
import type { CycleCollect, CycleScore, CycleStage } from './pipeline-cli.js';

const usage = `Один прогон конвейера: сбор вакансий → оценка found моделью → отправка queued в Job-Tracker.

  npm run cycle -- [--user me@example.com] [--dry-run] [--no-push] [--skip-collect] [--max-minutes 60]
                   [--model NAME] [--threshold N] [--limit N]
  npm run cycle -- --user me@example.com --source linkedin --query "node.js" [--location Remote]
                   [--include "node,typescript"] [--exclude "java,qa"] [другие флаги выше]

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

Отбор берёт все found, включая оставшиеся с прошлых прогонов. Брокер браузера недоступен — сбор
пропускается, отбор идёт. Ollama недоступна — отбор останавливается (код выхода 1).
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

    // ── 1. Сбор ──
    console.log('== Сбор ==');
    let collect: CycleStage<CycleCollect>;
    if (skipCollect) {
      collect = { ran: false, reason: '--skip-collect' };
    } else {
      const collector = createCollector(databaseUrl, process.env.AGENT_BROWSER_SOCKET || defaultBrokerSocket, log);
      try {
        let brokerDown: string | null = null;
        try { await collector.pingBrowser(signal); } catch (error) {
          if (!(error instanceof BrowserError)) throw error;
          brokerDown = error.message;
        }
        const interrupted = stopped();
        if (interrupted) {
          collect = { ran: false, reason: interrupted };
        } else if (brokerDown !== null) {
          log.warn(`Брокер браузера недоступен (${brokerDown}): сбор пропущен, отбор идёт по уже найденным.`);
          collect = { ran: false, reason: `брокер браузера недоступен — ${brokerDown}` };
        } else {
          const reports: SearchRunReport[] = adHoc
            ? [await collector.searches.runAdHoc(owner!.id, adHoc, { signal, dryRun })]
            : await collector.searches.runSaved({ signal, dryRun, ...(owner ? { ownerId: owner.id } : {}) });
          if (!reports.length) console.log('Включённых сохранённых поисков нет: добавьте их через POST /api/searches или запустите разовый поиск (--help).');
          for (const report of reports) print(['', ...searchReportLines(report, dryRun)]);
          if (reports.some((report) => report.stopped === 'error')) process.exitCode = 1;
          collect = { ran: true, result: { reports, dryRun } };
        }
      } finally { await collector.close(); }
    }

    // ── 2. Отбор и 3. отправка в Job-Tracker (внутри scoreFound) ──
    console.log('\n== Отбор ==');
    let score: CycleStage<CycleScore>;
    const stopReason = stopped();
    if (stopReason) {
      score = { ran: false, reason: stopReason };
    } else if (!tracker) {
      console.log('Job-Tracker не настроен: задайте JOB_TRACKER_URL и JOB_TRACKER_TOKEN в .env — профиль для оценки берётся оттуда.');
      score = { ran: false, reason: 'Job-Tracker не настроен (JOB_TRACKER_URL, JOB_TRACKER_TOKEN)' };
      process.exitCode = 1;
    } else {
      const reports: ScoringReport[] = [];
      const skippedOwners: { email: string; reason: string }[] = [];
      const owners = owner ? [owner] : await scorer.activeUsers();
      if (!owners.length) console.log('Активных пользователей нет.');
      for (const current of owners) {
        if (signal.aborted) break;
        console.log(`\n${current.email}`);
        const report = await scorer.scoring.scoreFound(current.id, {
          ...tuning, dryRun, push, signal,
          onJob: (line) => console.log(`  ${scoringLine(line)}`),
        });
        if (report.stopped === 'profile') {
          const reason = profileSkip(report);
          console.log(`  пропущен: ${reason}`);
          skippedOwners.push({ email: current.email, reason });
          if (owner) process.exitCode = 1;
          continue;
        }
        if (!report.lines.length && report.stopped === 'end') console.log('  новых вакансий для оценки нет');
        print(scoringSummaryLines(report, push));
        reports.push(report);
        if (report.stopped === 'model_unavailable') { process.exitCode = 1; break; }
      }
      score = { ran: true, result: { reports, skippedOwners, dryRun, push } };
    }

    print(['', ...cycleSummaryLines(collect, score)]);
  } finally { await scorer.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Цикл завершился ошибкой.');
  process.exitCode = 1;
});
