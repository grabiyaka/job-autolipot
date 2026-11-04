import '../plugins/environment.js';
import { parseArgs } from 'node:util';
import { createScorer } from '../framework/composition/create-scorer.js';
import { jobTrackerConfigFromEnv, ollamaConfigFromEnv } from '../plugins/environment.js';
import { SCORE_THRESHOLD } from '../src/scoring/ScoringRules.js';
import { profileSkip, scoreOptions, scoreSettings, scoringLine, scoringSummaryLines } from './pipeline-cli.js';

const usage = `Оценка найденных вакансий локальной моделью (Ollama) по профилю из Job-Tracker.

  npm run score -- [--user me@example.com] [--limit N] [--dry-run] [--model NAME] [--threshold N] [--no-push]

  --user       только этот пользователь; без него — все активные (не привязанные к Job-Tracker пропускаются)
  --limit      не больше N вакансий на пользователя (самые старые found)
  --dry-run    печатает оценки и решения, ничего не записывает и не отправляет в Job-Tracker
  --model      модель Ollama; по умолчанию OLLAMA_MODEL
  --threshold  с какой оценки вакансия идёт в очередь (queued); по умолчанию ${SCORE_THRESHOLD}
  --no-push    не отправлять queued в Job-Tracker после оценки

Ctrl+C дописывает текущую вакансию и останавливает прогон.
Строки: + в очередь, − отклонена, = повтор уже оценённой, ~ статус сменился во время оценки, ! ошибка.`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: scoreOptions });
  if (values.help) { console.log(usage); return; }
  const { dryRun, push, ...tuning } = scoreSettings(values);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан: выполните npm run setup в корне проекта (создаст .env).');
  const tracker = jobTrackerConfigFromEnv();
  if (!tracker) throw new Error('Job-Tracker не настроен: задайте JOB_TRACKER_URL и JOB_TRACKER_TOKEN в .env — профиль для оценки берётся оттуда.');

  const interrupt = new AbortController();
  process.once('SIGINT', () => { console.warn('! Остановка по Ctrl+C: дописываю текущую вакансию…'); interrupt.abort(); });

  const scorer = createScorer(databaseUrl, { ollama: ollamaConfigFromEnv(), tracker });
  try {
    let owners: { id: string; email: string }[];
    if (values.user) {
      const owner = await scorer.activeUser(values.user);
      if (!owner) throw new Error(`Активный пользователь ${values.user} не найден.`);
      owners = [owner];
    } else {
      owners = await scorer.activeUsers();
    }

    for (const owner of owners) {
      if (interrupt.signal.aborted) break;
      console.log(`\n${owner.email}`);
      const report = await scorer.scoring.scoreFound(owner.id, {
        ...tuning, dryRun, push, signal: interrupt.signal,
        onJob: (line) => console.log(`  ${scoringLine(line)}`),
      });
      if (report.stopped === 'profile') {
        console.log(`  пропущен: ${profileSkip(report)}`);
        if (values.user) process.exitCode = 1;
        continue;
      }
      if (!report.lines.length && report.stopped === 'end') console.log('  новых вакансий для оценки нет');
      console.log(scoringSummaryLines(report, push).join('\n'));
      if (report.stopped === 'model_unavailable') { process.exitCode = 1; break; }
    }
  } finally { await scorer.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Оценка вакансий завершилась ошибкой.');
  process.exitCode = 1;
});
