import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const template = await readFile(new URL('.env.example', root), 'utf8');
const environment = template.replace('JWT_SECRET=replace-with-a-random-secret', `JWT_SECRET=${randomBytes(48).toString('base64url')}`);
try {
  await writeFile(new URL('.env', root), environment, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with a random JWT secret. Run docker compose up --build -d.');
  console.log('Create your login: docker compose exec api npm run user:create -- --email admin@example.com --name Admin --role admin');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; existing configuration was preserved.');
}
