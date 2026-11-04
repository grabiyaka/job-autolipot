# Фаза 3: решения, окружение и результаты пробы

Всё, что решено с пользователем и проверено вживую. Менять только с его согласия.

## Решения пользователя

| Вопрос | Решение | Когда |
|---|---|---|
| Откуда подача берёт вакансии | из **Job-Tracker To Apply** (`GET /api/ai/jobs?evaluation=any`), а не из локальных `queued`; в To Apply можно чистить список вручную | 2026-11-03 |
| Какие формы поддерживаем сначала | только **LinkedIn Easy Apply**; внешние сайты (Greenhouse, Lever, Workday…) → `skipped`, «внешняя подача» | 2026-11-03 |
| Кто нажимает Submit на старте | агент останавливается перед Submit; отправка — отдельной командой после твоей проверки (`npm run apply -- --submit <id>`, позже кнопка ✅ в Telegram) | 2026-11-03 |
| Сопроводительное письмо, необязательные поля | **оставлять пустыми**, если поле не обязательное | 2026-11-03 |
| Бюджет | одна подача — центы; лимит по умолчанию на запуск и на день задаётся в `.env`, считается по токенам | 2026-11-03 |
| CV | **PDF** из `/srv/agent-files/Illia Herasymets - Current Resume.pdf` (не загруженный ранее в LinkedIn `.docx`) | 2026-11-03 |
| Годы опыта TypeScript | **1 год** | 2026-11-03 |
| Email в формах | `illia.herasymets@gmail.com` | 2026-11-03 |
| Согласие на обработку данных при отклике | **разрешено** ставить автоматически. Прочие юридические заявления, создание аккаунтов, пароли, оплата, капча — никогда | 2026-11-03 |
| Зарплата / ставка | **фиксированного ответа нет, опираемся на вакансию**: если в вакансии есть вилка — ответ внутри неё и не ниже минимума профиля; если нет — цель профиля; единицы (час/месяц/год) пересчитываются. Подробно — [a-answers.md](a-answers.md#правило-по-зарплате) | 2026-11-04 |
| Порядок работ | банк ответов → **Telegram-бот с расписанием** (запуск сбора и оценки, cron, вкл/выкл) → подача → автоподача в боте | 2026-11-04 |

Профиль кандидата (минимум 40 000 / цель 48 000 EUR в год, локация, право на работу, контакты)
берётся из Job-Tracker (`GET /api/ai/profile-context`), в репозиторий не копируется.

## Окружение (проверено 2026-11-03)

| Что | Где | Заметки |
|---|---|---|
| `claude` CLI | `~/.local/bin/claude`, 2.1.318 | запуск агента в режиме `-p` |
| Настройки DeepSeek | `~/.config/deepseek/claude-settings.json` (`env`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, модели) | ключ в `~/.config/deepseek/api_key`; права 600; **не выводить** |
| Модель | `deepseek-flash[1m]` (так её называет `claude`) | `claude` пишет `unrecognized_model` в stderr — не ошибка |
| Playwright MCP | `agent-playwright-mcp.service`, `http://127.0.0.1:8931/mcp`, user `agent` | CDP к тому же agent Chromium (`:9222`), что и брокер сборщика; `--snapshot-mode none` (снимок страницы только через `browser_snapshot`) |
| Файлы для загрузки | `/srv/agent-files` (группа `agent`), MCP видит только её (`ReadOnlyPaths`) | CV лежит там |
| Скриншоты MCP | `/var/lib/agent-playwright-mcp/output` | для `elijah` закрыта — нужна общая папка |
| Брокер браузера (только чтение) | `/run/agent-browser/broker.sock` | сборщик, `npm run browser:check` |
| noVNC | `http://127.0.0.1:6080` | смотреть, что агент заполнил |
| Telegram-бот local-agent | `agent-tg-bot.service` (Python, `/opt/agent-tg`) | **тоже ходит в этот браузер** — конфликт за вкладку |
| Job-Tracker | прод `https://job-tracker.elijah.kiev.ua`, код `~/projects/Job-Tracker` | AI API: `docs/AI_API.md`; лимит 60 запросов/мин |

## Факты о Job-Tracker, важные для подачи

- To Apply = `JobOpportunity`. `GET /api/ai/jobs` отдаёт их **от старых к новым**, параметр
  `evaluation=none|stale|needed|any`, `limit` до 100, курсор. Вакансии, превращённые в Application,
  в список не попадают.
- `docs/AI_API.md`: агент «создаёт вакансии и **никогда не отмечает поданными**». Для подачи нужен
  новый эндпоинт — [e-job-tracker.md](e-job-tracker.md).
- Статусы Application в JT: `DRAFT, APPLIED, VIEWED, CONTACTED, SCREENING, INTERVIEW, …, REJECTED,
  WITHDRAWN, GHOSTED`.
- В autopilot у локальной вакансии есть `trackerId` (id JobOpportunity в JT) — по нему связываем.

## Живая проба DeepSeek, 2026-11-03

Вакансия: LinkedIn «Backend Engineer (Node.js / TypeScript)», Nexoya, Easy Apply, 4 шага.
Команда (из временной папки; промпт, хук и схема — в [c-agent-runner.md](c-agent-runner.md)):

```bash
claude -p "Apply to this job: <url> … Stop before Submit." \
  --settings ~/.config/deepseek/claude-settings.json --setting-sources project \
  --mcp-config mcp.json --strict-mcp-config \
  --system-prompt-file system.md \
  --allowedTools "<список инструментов Playwright>" --disallowedTools "<запрещённые>" \
  --permission-mode dontAsk \
  --json-schema "$(cat schema.json)" --output-format json --max-budget-usd 5
```

| Прогон | Итог | Время | Ходов | Токены (вход / из кеша / выход) |
|---|---|---|---|---|
| 1 | прерван `--max-budget-usd 0.5` на шаге 2 | 66 с | 15 | 49k / 394k / 3k |
| 2 | `needs_input` — правильно | 84 с | 18 | 31k / 327k / 5k |

Что показала проба:

1. **Подход работает.** Агент сам нашёл Easy Apply, прошёл шаги, выбрал резюме, заполнил контакты,
   «когда можете начать» и ставку, и **остановился** на обязательном вопросе без ответа в профиле
   («Years of experience working with TypeScript») вместо того, чтобы угадывать.
2. **Цена — около 2 центов за вакансию** по ценам DeepSeek. Встроенный `--max-budget-usd` для
   DeepSeek бесполезен: `claude` считает по ценам Claude (`costBasis: unknown`, «$0.43»). Стоимость
   считаем сами по токенам и ценам из `.env`.
3. **Хук ни разу не сработал** — агент сам не пытался нажать Submit и уйти с linkedin.com. Хук всё
   равно обязателен.
4. **Нарушение:** агент сам отметил согласие с Terms & Conditions / Data Privacy (JOIN). По решению
   выше согласие на обработку данных теперь разрешено, но это должно приходить **из банка ответов**,
   а не из догадки модели.
5. **Email:** в Easy Apply email выбирается из адресов аккаунта LinkedIn; там только другой, старый адрес.
   Нужный адрес надо добавить в LinkedIn.
6. **Резюме:** агент выбрал уже загруженный в LinkedIn `.docx`. Решено: PDF — правило в промпт.
7. **Easy Apply редок:** у 4 из 5 отобранных вакансий кнопка ведёт на сайт компании. Сборщику нужен
   фильтр LinkedIn `f_AL=true` (только Easy Apply) — [c-agent-runner.md](c-agent-runner.md#4-флаг-сборщика---easy-apply).
8. Агент экономен со снимками только если попросить: «one snapshot per step».
