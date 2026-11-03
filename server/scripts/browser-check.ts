import '../plugins/environment.js';
import { parseArgs } from 'node:util';
import { createBrokerBrowser, defaultBrokerSocket } from '../plugins/browser-broker.js';

const usage = `npm run browser:check -- [--open URL]
Без --open только читает: ping и текущая страница. С --open переводит общую вкладку agent Chromium на URL
и печатает заголовок, начало текста и первые ссылки. Сокет: AGENT_BROWSER_SOCKET или ${defaultBrokerSocket}.`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { open: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(usage); return; }
  const browser = createBrokerBrowser({ socketPath: process.env.AGENT_BROWSER_SOCKET || defaultBrokerSocket });

  const status = await browser.ping();
  console.log(`брокер: connected=${status.connected}, chromium ${status.chromium}`);
  console.log(`allow-list: ${status.allowList}`);
  const current = await browser.currentPage();
  console.log(`текущая страница: ${current ? `${current.title} — ${current.url}` : 'нет'}`);
  if (!values.open) return;

  const opened = await browser.open(values.open);
  console.log(`\nоткрыто: ${opened.title} — ${opened.url} (HTTP ${opened.status ?? '?'})`);
  const { text } = await browser.text();
  console.log(`текст: ${text.length} символов; начало:\n${text.slice(0, 400).replace(/\n{2,}/g, '\n')}\n…`);
  const { links } = await browser.links();
  console.log(`ссылки (разрешённые allow-list): ${links.length}; первые 10:`);
  for (const link of links.slice(0, 10)) console.log(`  ${link.href}  «${link.text}»`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'Проверка браузера завершилась ошибкой.');
  process.exitCode = 1;
});
