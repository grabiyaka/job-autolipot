import { parseArgs } from 'node:util';
import type { Answer } from '../src/answers/AnswerService.js';

/** Argument parsing and printing of the answers script. Pure, so it is tested without a database. */

export type AnswersCommand =
  | Readonly<{ action: 'help' }>
  | Readonly<{ action: 'list'; user: string }>
  | Readonly<{ action: 'set'; user: string; question: string; answer: string }>
  | Readonly<{ action: 'delete'; user: string; id: string }>;

const usageHint = 'Использование: npm run answers -- --user <email> list | set "<вопрос>" "<ответ>" | delete <id>';

export function answersCommand(args: readonly string[]): AnswersCommand {
  const { values, positionals } = parseArgs({
    args: [...args], allowPositionals: true,
    options: { user: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) return { action: 'help' };
  const [action, ...rest] = positionals;
  if (!values.user) throw new Error(`Укажите --user. ${usageHint}`);
  const user = values.user;
  const expect = (count: number, shape: string) => {
    if (rest.length !== count) throw new Error(`${action}: ожидается ${shape}. ${usageHint}`);
  };
  switch (action) {
    case 'list': expect(0, 'без аргументов'); return { action, user };
    case 'set': expect(2, '"<вопрос>" "<ответ>" (каждый в кавычках)'); return { action, user, question: rest[0]!, answer: rest[1]! };
    case 'delete': expect(1, '<id>'); return { action, user, id: rest[0]! };
    default: throw new Error(`${action ? `Неизвестная команда «${action}». ` : 'Не указана команда. '}${usageHint}`);
  }
}

const indented = (text: string) => text.split('\n').map((line) => `    ${line}`).join('\n');

/** One block per answer: id and origin, the question, then the answer indented (rules can span lines). */
export function answerLines(answers: readonly Answer[]): string[] {
  if (!answers.length) return ['Ответов пока нет.'];
  return answers.flatMap((answer) => [`${answer.id}  [${answer.origin}]`, `  ${answer.question}`, indented(answer.answer)]);
}
