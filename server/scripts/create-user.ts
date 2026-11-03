import '../plugins/environment.js';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { createUserAdministration } from '../framework/composition/create-user-administration.js';
import { isUserRole, userRoles } from '../framework/core/roles.js';

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      for await (const line of input) return line;
      throw new Error('Пароль не получен через stdin.');
    } finally { input.close(); }
  }
  process.stdout.write(prompt);
  const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: mutedOutput, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      input.once('SIGINT', () => reject(new Error('Создание пользователя отменено.')));
      input.once('close', () => reject(new Error('Ввод пароля завершён без ответа.')));
      input.question('', resolve);
    });
  } finally {
    input.close();
    process.stdout.write('\n');
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'manager' },
    'subscriber-id': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`npm run user:create -- --email user@example.com --name User [--role ${userRoles.join('|')}] [--subscriber-id ID]`);
    console.log('Роль по умолчанию: manager. Необязательная связь --subscriber-id доступна только роли guest для предметного примера.');
    console.log('Пароль: скрытый интерактивный ввод либо одна строка через stdin. Параметр --password не поддерживается.');
    return;
  }
  if (!values.email || !values.name) throw new Error('Укажите --email и --name. Справка: npm run user:create -- --help.');
  if (!isUserRole(values.role)) throw new Error(`Роль должна быть одной из: ${userRoles.join(', ')}.`);
  if (values['subscriber-id'] !== undefined && (values.role !== 'guest' || !values['subscriber-id'].trim())) {
    throw new Error('--subscriber-id принимает непустой ID и доступен только роли guest.');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required in ../.env or the process environment.');
  const password = await readPassword('Пароль (12–128 символов): ');
  if (process.stdin.isTTY && password !== await readPassword('Повторите пароль: ')) throw new Error('Пароли не совпадают.');
  const administration = createUserAdministration(databaseUrl);
  try {
    const user = await administration.users.create({
      email: values.email, name: values.name, role: values.role, password,
      ...(values['subscriber-id'] ? { subscriberId: values['subscriber-id'] } : {}),
    });
    console.log(`Пользователь создан: ${user.email} (${user.role}), id=${user.id}`);
  } finally { await administration.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Не удалось создать пользователя.');
  process.exitCode = 1;
});
