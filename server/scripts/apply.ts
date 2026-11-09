import '../plugins/environment.js';
import { createApplier } from '../framework/composition/create-applications.js';
import { agentBackendFromEnv, applySettingsFromEnv, claudeAgentConfigFromEnv, jobTrackerConfigFromEnv } from '../plugins/environment.js';
import { answerLines, applyCommand, fillLines, pendingLines, submitLines } from './apply-cli.js';

const usage = `Подача на вакансии из Job-Tracker To Apply через агента: LinkedIn Easy Apply и формы на сайтах компаний / ATS.
Агент заполняет форму и останавливается перед отправкой; отправка — только отдельной командой после вашей проверки.
Сайты с аккаунтом или капчей (Workday, iCIMS…) — «подать вручную»: ссылка в --list, после подачи --manual-applied.

  npm run apply -- --user me@example.com [--limit N] [--job <id>]   заполнить следующие (по умолчанию APPLY_MAX_PER_RUN)
  npm run apply -- --user me@example.com --list                     что ждёт ✅ и какие вопросы открыты
  npm run apply -- --user me@example.com --submit <applicationId>   отправить заполненную попытку и отметить в Job-Tracker
                                                                    (внешняя форма заполняется заново и отправляется — ещё один прогон агента)
  npm run apply -- --user me@example.com --reject <applicationId>   отказаться: вакансия skipped («отклонено вручную»)
  npm run apply -- --user me@example.com --manual-applied <applicationId>   подал сам (попытка manual): applied и отметка в Job-Tracker
  npm run apply -- --user me@example.com --answer <questionId> "<ответ>"   ответ в банк; после последнего — вакансия снова queued

Автоподача (заполнить и сразу отправить, без ✅; агент — Claude на подписке):
  npm run autoapply [-- --limit N] [--job <id>]                    то же, что apply --auto --agent claude

--auto: агент отправляет форму сам (как APPLY_AUTO_SUBMIT=true); вопрос без ответа — needs_input, без отправки.
--agent claude|deepseek: чем заполнять (по умолчанию APPLY_AGENT, иначе deepseek). Claude: модель APPLY_CLAUDE_MODEL (sonnet),
  лимит APPLY_CLAUDE_MAX_USD_PER_DAY (10, по прайсу API — на подписке условно).
--user: по умолчанию BOT_USER из .env, иначе единственный активный пользователь.
--job: id вакансии здесь или в Job-Tracker; берётся, даже если её нет в To Apply или она failed/skipped.
Лимиты: APPLY_MAX_PER_RUN (5), APPLY_MAX_USD_PER_DAY (0.5, сутки по UTC). Резюме: APPLY_CV_FILE.
Ctrl+C останавливает запуск: текущая попытка помечается остановленной, вакансия возвращается в очередь.`;

async function main(): Promise<void> {
  const command = applyCommand(process.argv.slice(2));
  if (command.action === 'help') { console.log(usage); return; }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан: выполните npm run setup в корне проекта (создаст .env).');

  const fill = command.action === 'fill' ? command : null;
  const backend = fill?.agent ?? agentBackendFromEnv();
  const apply = applySettingsFromEnv(process.env, backend);
  const applier = createApplier(databaseUrl, {
    tracker: jobTrackerConfigFromEnv(), agentConfig: () => claudeAgentConfigFromEnv(process.env, backend),
    apply: fill?.auto ? { ...apply, autoSubmit: true } : apply,
  });
  if (fill) console.warn(`агент: ${backend}${fill.auto || apply.autoSubmit ? ', автоотправка без ✅' : ', стоп перед отправкой'}`);
  const stop = new AbortController();
  process.once('SIGINT', () => { console.warn('! Ctrl+C: останавливаю агента…'); stop.abort(); });
  try {
    const owner = await applier.activeUser(command.user ?? (process.env.BOT_USER?.trim() || null));
    const { applications } = applier;
    let lines: string[];
    switch (command.action) {
      case 'fill':
        lines = fillLines(await applications.fillNext(owner.id, {
          signal: stop.signal, ...(command.limit !== undefined ? { limit: command.limit } : {}), ...(command.jobId ? { jobId: command.jobId } : {}),
        }));
        break;
      case 'list': lines = pendingLines(await applications.pending(owner.id)); break;
      case 'submit': lines = submitLines(await applications.submit(owner.id, command.applicationId, stop.signal)); break;
      case 'reject': {
        const rejected = await applications.reject(owner.id, command.applicationId);
        lines = [`skipped: ${rejected.jobTitle} — ${rejected.company} (отклонено вручную)`];
        break;
      }
      case 'manualApplied': lines = submitLines(await applications.markManualApplied(owner.id, command.applicationId)); break;
      case 'answer': lines = answerLines(await applications.answerQuestion(owner.id, command.questionId, command.answer, 'manual')); break;
    }
    console.log(lines.join('\n').replaceAll('<email>', owner.email));
  } finally {
    await applier.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Команда apply завершилась ошибкой.');
  process.exitCode = 1;
});
