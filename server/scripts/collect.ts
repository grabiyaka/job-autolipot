import '../plugins/environment.js';
import { parseArgs } from 'node:util';
import { createCollector } from '../framework/composition/create-collector.js';
import { defaultBrokerSocket } from '../plugins/browser-broker.js';
import { searchSources } from '../src/searches/SearchSources.js';
import type { SearchRunReport, SearchStopReason } from '../src/searches/SearchService.js';
import type { Logger } from '../src/searches/SearchTypes.js';

const usage = `Сбор вакансий.

Разовый поиск (ничего не сохраняет о самом поиске; вакансии пишутся в jobs, с --dry-run только печатаются):
  npm run collect -- --user me@example.com --source linkedin --query "node.js" [--location Remote]
                     [--include "node,typescript"] [--exclude "java,android,qa"] [--dry-run] [--max-minutes 60]

Сохранённые поиски (POST /api/searches; отчёт каждого — в search_runs):
  npm run collect -- [--user me@example.com] [--dry-run] [--max-minutes 60]

  --location   "Remote" — фильтр удалённой работы, иначе город или страна
  --include    слова через запятую: в названии вакансии должно быть хотя бы одно
  --exclude    слова через запятую: вакансия с любым из них в названии отсеивается
               до открытия её страницы и сохраняется как rejected (с причиной в why)
               Слова ищутся целиком без учёта регистра: "java" не задевает "JavaScript".
  --dry-run    печатает найденное (+ принята, − отсеяна) и ничего не записывает
  --max-minutes  предел длительности; Ctrl+C тоже останавливает, дописав текущую страницу

Источники: ${searchSources.map((source) => source.id).join(', ') || 'пока не подключены'}`;

const log: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`! ${message}`),
};

const stopReasons: Record<SearchStopReason, string> = {
  end: 'выдача закончилась',
  known: 'дальше уже известные вакансии',
  limit: 'достигнут предел страниц источника',
  aborted: 'остановлен (Ctrl+C или --max-minutes)',
  error: 'ошибка',
};

function printReport(report: SearchRunReport, dryRun: boolean): void {
  const saved = dryRun ? 'не записано (--dry-run)' : `записано ${report.created}, дублей ${report.duplicates}`;
  console.log(`\n${report.source} «${report.query.keywords}»${report.query.location ? ` (${report.query.location})` : ''}`);
  console.log(`  страниц ${report.pages}, карточек ${report.seen}, новых ${report.fresh}, `
    + `из них отсеяно по названию ${report.filtered}; ${saved}, некорректных ${report.invalid}`);
  console.log(`  остановка: ${stopReasons[report.stopped]}${report.error ? ` — ${report.error}` : ''}`);
}

const words = (value: string | undefined): string[] | undefined => value?.split(',').map((word) => word.trim()).filter(Boolean);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    user: { type: 'string' }, source: { type: 'string' }, query: { type: 'string' }, location: { type: 'string' },
    include: { type: 'string' }, exclude: { type: 'string' },
    'dry-run': { type: 'boolean' }, 'max-minutes': { type: 'string', default: '60' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); return; }
  const adHoc = [values.source, values.query, values.location, values.include, values.exclude].some((value) => value !== undefined);
  if (adHoc && (!values.user || !values.source || !values.query)) {
    throw new Error(`Для разового поиска укажите --user, --source и --query.\n\n${usage}`);
  }
  const maxMinutes = Number(values['max-minutes']);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes — положительное число.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан: выполните npm run setup в корне проекта (создаст .env).');

  const interrupt = new AbortController();
  process.once('SIGINT', () => { log.warn('Остановка по Ctrl+C: дописываю текущую страницу…'); interrupt.abort(); });
  const signal = AbortSignal.any([interrupt.signal, AbortSignal.timeout(maxMinutes * 60_000)]);
  const dryRun = values['dry-run'] ?? false;

  const collector = createCollector(databaseUrl, process.env.AGENT_BROWSER_SOCKET || defaultBrokerSocket, log);
  try {
    let ownerId: string | undefined;
    if (values.user) {
      ownerId = await collector.activeUserId(values.user) ?? undefined;
      if (!ownerId) throw new Error(`Активный пользователь ${values.user} не найден. Создайте его: npm run user:create -- --email ${values.user} --name …`);
    }
    const reports = adHoc
      ? [await collector.searches.runAdHoc(ownerId!, {
        source: values.source!, keywords: values.query!, location: values.location ?? null,
        includeTitle: words(values.include) ?? null, excludeTitle: words(values.exclude) ?? null,
      }, { signal, dryRun })]
      : await collector.searches.runSaved({ signal, dryRun, ...(ownerId ? { ownerId } : {}) });
    if (!reports.length) console.log('Включённых сохранённых поисков нет: добавьте их через POST /api/searches или запустите разовый поиск (--help).');
    for (const report of reports) printReport(report, dryRun);
    if (reports.some((report) => report.stopped === 'error')) process.exitCode = 1;
  } finally { await collector.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Сбор вакансий завершился ошибкой.');
  process.exitCode = 1;
});
