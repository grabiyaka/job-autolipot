import { parseArgs } from 'node:util';
import { usd } from '../src/applications/ApplicationRules.js';
import type {
  AnswerReport, ApplicationView, FillReport, PendingView, QuestionView, SubmitReport,
} from '../src/applications/ApplicationTypes.js';

/** Argument parsing and printing of `npm run apply`. Pure, so it is tested without a database or an agent. */

export type ApplyCommand =
  | Readonly<{ action: 'help' }>
  | Readonly<{ action: 'fill'; user: string; limit?: number; jobId?: string }>
  | Readonly<{ action: 'list'; user: string }>
  | Readonly<{ action: 'submit'; user: string; applicationId: string }>
  | Readonly<{ action: 'reject'; user: string; applicationId: string }>
  | Readonly<{ action: 'answer'; user: string; questionId: string; answer: string }>;

export const applyUsageHint = 'Использование: npm run apply -- --user <email> [--limit N] [--job <id>] | --list | --submit <id> | --reject <id> | --answer <questionId> "<ответ>"';

export function applyCommand(args: readonly string[]): ApplyCommand {
  const { values, positionals } = parseArgs({
    args: [...args], allowPositionals: true,
    options: {
      user: { type: 'string' }, limit: { type: 'string' }, job: { type: 'string' }, list: { type: 'boolean' },
      submit: { type: 'string' }, reject: { type: 'string' }, answer: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { action: 'help' };
  if (!values.user) throw new Error(`Укажите --user. ${applyUsageHint}`);
  const user = values.user;
  const modes = [values.list && '--list', values.submit && '--submit', values.reject && '--reject', values.answer && '--answer'].filter(Boolean);
  if (modes.length > 1) throw new Error(`Можно только одно из ${modes.join(', ')}. ${applyUsageHint}`);
  if (modes.length && (values.limit || values.job)) throw new Error(`--limit и --job — только для заполнения. ${applyUsageHint}`);
  if (values.answer) {
    if (positionals.length !== 1 || !positionals[0]!.trim()) throw new Error(`--answer <questionId> "<ответ>": ответ — один аргумент в кавычках. ${applyUsageHint}`);
    return { action: 'answer', user, questionId: values.answer, answer: positionals[0]! };
  }
  if (positionals.length) throw new Error(`Лишние аргументы: ${positionals.join(' ')}. ${applyUsageHint}`);
  if (values.list) return { action: 'list', user };
  if (values.submit) return { action: 'submit', user, applicationId: values.submit };
  if (values.reject) return { action: 'reject', user, applicationId: values.reject };
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit — целое число от 1.');
  }
  return { action: 'fill', user, ...(limit !== undefined ? { limit } : {}), ...(values.job ? { jobId: values.job } : {}) };
}

const stopWords: Record<FillReport['stopped'], string> = {
  end: 'подходящих вакансий больше нет',
  limit: 'достигнут лимит запусков агента (--limit / APPLY_MAX_PER_RUN)',
  budget: 'достигнут дневной лимит затрат (APPLY_MAX_USD_PER_DAY)',
  aborted: 'остановлено',
};

export function filledLines(application: Pick<ApplicationView, 'filled'>): string[] {
  return application.filled.map((item) => `    ${item.field}: ${item.value}`);
}

export function fillLines(report: FillReport): string[] {
  const lines: string[] = [];
  for (const item of report.resent) lines.push(`Job-Tracker: ${item.title} — ${item.result}`);
  if (!report.lines.length) lines.push('Подходящих вакансий в To Apply нет.');
  for (const line of report.lines) {
    lines.push(`${line.status.padEnd(11)} ${line.title} — ${line.company}${line.costMicros ? ` (${usd(line.costMicros)})` : ''}`);
    lines.push(`    ${line.note}`);
  }
  for (const application of report.ready) {
    lines.push('', `Ждёт ✅: ${application.jobTitle} — ${application.company}`, `  ${application.url}`, ...filledLines(application),
      `  отправить: npm run apply -- --user <email> --submit ${application.id}`);
  }
  for (const question of report.questions) lines.push('', ...questionLines(question));
  lines.push('', `Итог: ${stopWords[report.stopped]}; потрачено сегодня ${usd(report.spentTodayMicros)} из ${usd(report.budgetMicros)}.`);
  return lines;
}

export function questionLines(question: QuestionView): string[] {
  return [`Вопрос ${question.id} (${question.jobTitle} — ${question.company}):`, `  ${question.text}`,
    `  ответить: npm run apply -- --user <email> --answer ${question.id} "<ответ>"`];
}

export function pendingLines(pending: PendingView): string[] {
  const lines: string[] = [];
  lines.push(pending.ready.length ? 'Ждут ✅:' : 'Заполненных попыток, ждущих ✅, нет.');
  for (const application of pending.ready) {
    lines.push(`  ${application.id}  ${application.jobTitle} — ${application.company}`, `    ${application.url}`,
      ...filledLines(application).map((line) => `  ${line}`));
  }
  lines.push('', pending.questions.length ? 'Открытые вопросы:' : 'Открытых вопросов нет.');
  for (const question of pending.questions) lines.push(`  ${question.id}  ${question.jobTitle} — ${question.company}`, `    ${question.text}`);
  return lines;
}

export function submitLines(report: SubmitReport): string[] {
  return [`${report.application.status}: ${report.application.jobTitle} — ${report.application.company}`, `  ${report.message}`];
}

export function answerLines(report: AnswerReport): string[] {
  return [
    `Записано в банк ответов: ${report.question.text} → ${report.question.answer ?? ''}`,
    report.requeued ? 'Все вопросы попытки закрыты: вакансия снова в очереди, следующий запуск заполнит форму заново.'
      : report.remaining ? `Осталось вопросов по этой попытке: ${report.remaining}.` : '',
  ].filter(Boolean);
}
