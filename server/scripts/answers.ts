import '../plugins/environment.js';
import { createAnswerCli } from '../framework/composition/create-answers.js';
import { answerLines, answersCommand } from './answers-cli.js';

const usage = `Банк ответов на вопросы форм: агент подачи берёт ответы отсюда, а не угадывает.

  npm run answers -- --user me@example.com list
  npm run answers -- --user me@example.com set "<вопрос>" "<ответ>"
  npm run answers -- --user me@example.com delete <id>

  list    все ответы пользователя: id, откуда (manual / telegram), вопрос, ответ
  set     записать ответ; тот же вопрос в другой формулировке («Years of experience with TypeScript»
          и «How many years of TypeScript experience?») заменяет прежний ответ
  delete  удалить ответ по id из list

Ответ может быть правилом («base the number on the posting…»): агент получает его как инструкцию.`;

async function main(): Promise<void> {
  const command = answersCommand(process.argv.slice(2));
  if (command.action === 'help') { console.log(usage); return; }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL не задан: выполните npm run setup в корне проекта (создаст .env).');

  const cli = createAnswerCli(databaseUrl);
  try {
    const actor = await cli.activeUser(command.user);
    if (!actor) throw new Error(`Активный пользователь ${command.user} не найден.`);
    switch (command.action) {
      case 'list':
        console.log(answerLines(await cli.answers.list(actor)).join('\n'));
        break;
      case 'set': {
        const saved = await cli.answers.put(actor, { question: command.question, answer: command.answer });
        console.log(`Записано: ${saved.id}`);
        break;
      }
      case 'delete':
        await cli.answers.remove(actor, command.id);
        console.log(`Удалено: ${command.id}`);
        break;
    }
  } finally { await cli.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Команда answers завершилась ошибкой.');
  process.exitCode = 1;
});
