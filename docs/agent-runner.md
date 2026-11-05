# Агент подачи: запуск и защита

Техническая основа подачи откликов (фаза 3, пакет В). Здесь описано, как приложение запускает
`claude -p` на DeepSeek с Playwright MCP и что ему запрещено. Заполнение формы, статусы подачи
и команда `npm run apply` — пакет Г, их пока нет ([план](phase3/d-applications.md)).

## Что работает

Всё ниже покрыто тестами на фейковом `claude`. Первый живой прогон в режиме `fill` 2026-11-04
показал, что хук срабатывает на каждый вызов; после него разрешены `StructuredOutput` и `ToolSearch`.

### Плагин `server/plugins/claude-agent.ts`

`createClaudeAgent(config).run({ prompt, systemPrompt, schema, mode, resumeSessionId?, signal })`
возвращает `{ output, subtype, sessionId, turns, durationMs, tokens: { input, cacheRead, output },
costMicros, guardLog, runDir }`. Настройки из `.env` даёт `claudeAgentConfigFromEnv()`
в `plugins/environment.ts`.

- **Запуск.** `claude` запускается через `spawn` без shell. Аргументы как в пробе
  ([decisions.md](phase3/decisions.md#живая-проба-deepseek-2026-11-03)): `--settings <DEEPSEEK_SETTINGS>`,
  `--setting-sources project`, `--mcp-config` с `--strict-mcp-config`, `--system-prompt-file`,
  списки `--allowedTools` и `--disallowedTools`, `--permission-mode dontAsk`, `--json-schema`,
  `--output-format json` и `--resume` для продолжения сессии.
- **Две папки.**
  - **cwd процесса `claude`** — `AGENT_CWD`, по умолчанию `/srv/agent-files/agent-run`. При каждом
    запуске плагин пишет туда `.claude/settings.json` с хуками PreToolUse (все инструменты)
    и PostToolUse (`mcp__playwright__.*`), — оба вызывают один скрипт, —
    `mcp.json` (`PLAYWRIGHT_MCP_URL`) и `files/` с копиями файлов для загрузки.
  - **Логи попыток** — `server/data/agent/runs/<время>-<id>/` (в `.gitignore` через `server/data/`):
    `system.md`, `guard-log.jsonl`, `refs.json` (элементы страницы из снимков) и метка `submit-click`.
    Старые попытки не удаляются.
- **Почему cwd вне `/home`.** Playwright MCP разрешает загружать файлы только из своего `--output-dir`
  и из cwd процесса-клиента, то есть `claude`. Если файл лежит в другом месте, MCP отвечает
  «File access denied … outside allowed roots». Сам сервис `agent-playwright-mcp` работает
  как `User=agent` с `ProtectHome=yes` и `ReadOnlyPaths=/srv/agent-files`, так что `/home` ему
  не виден. Поэтому cwd лежит внутри `/srv/agent-files`. Права там такие: `elijah:agent`, setgid,
  `elijah` может писать, группа `agent` — читать.
- **Файлы для загрузки.** Перед каждым запуском плагин (`syncAgentFiles`) копирует обычные файлы
  `.pdf`, `.doc` и `.docx` из верхнего уровня `/srv/agent-files/` в `<AGENT_CWD>/files/`.
  - Подпапки и другие файлы пропускаются. Копия перезаписывается, если у неё отличается размер
    или mtime.
  - Права: папка `files/` — `02750`, файлы — `0640`. Группу `agent` им даёт setgid родителя.
  - `elijah` не входит в группу `agent`, а Linux снимает setgid при `chmod` от не-члена группы.
    Поэтому папку, потерявшую setgid, плагин не чинит через `chmod`: он удаляет её (там только
    копии) и создаёт заново, и новая папка наследует setgid и группу.
  - После копирования группа файла сверяется с группой папки. Копия с чужой группой удаляется
    и копируется снова. Если не помогло — `AgentUnavailableError`.
  - Так чинится и состояние живого прогона 3 (2026-11-04): `files/` без setgid, а резюме
    с группой `elijah` давало EACCES у MCP.
  - Путь копии для промпта даёт `agentUploadPath(fileName)`, например
    `/srv/agent-files/agent-run/files/<CV>.pdf`.
  - Если источник недоступен, бросается `AgentUnavailableError`.
- **Окружение процесса.** `claude` получает env приложения плюс `APPLY_MODE`, `APPLY_GUARD_DIR` (папка попытки)
  и `APPLY_UPLOAD_DIR` (`<AGENT_CWD>/files`).
  `CLAUDECODE` убирается, чтобы запуск из сессии Claude не считался вложенным.
- **Секреты.** Файл `DEEPSEEK_SETTINGS` проверяется только на существование, не читается
  и не логируется.
- **Стоимость.** Считается по токенам из `modelUsage`: `costMicros` = Σ токены × цена USD за 1M.
  Цены берутся из `DEEPSEEK_PRICE_*`, вход кеш-промаха включает запись в кеш.
  `total_cost_usd` от `claude` не используется: он считает по ценам Claude. Без цен агент не создаётся.
- **Ошибки.** Все наследуют `AgentError`, где есть `runDir` и `guardLog`, а когда `claude`
  успел их сообщить — `subtype`, `sessionId`, `turns`, `tokens` и `costMicros`.
  - `AgentUnavailableError` — нет `claude` или файла настроек.
  - `AgentTimeoutError` — истёк `APPLY_TIMEOUT_MS`: SIGTERM, через 5 с SIGKILL.
  - `AgentResponseError` — не JSON, `subtype` не `success` (например `error_max_turns`;
    токены и стоимость при этом заполнены), `is_error` или нет `structured_output`.
  - `signal` убивает процесс тем же способом, плагин бросает `signal.reason`.
- **Промпт.** Промпт, начинающийся с `-`, отклоняется: `claude` принял бы его за флаг.

### Защита: `plugins/agent-guard-rules.ts` и хук `scripts/agent-guard.ts`

Правила — чистая функция `guardDecision(mode, tool, args, state, { uploadDir, refs })`. Хук
вызывается `claude` перед каждым инструментом (PreToolUse) и после каждого инструмента Playwright
(PostToolUse); событие он узнаёт из `hook_event_name`. Вызов приходит JSON-ом на stdin, режим —
из `APPLY_MODE`, а пустой или неизвестный режим считается `fill`. Каждый вызов и решение хук пишет
строкой в `guard-log.jsonl`; этот лог плагин возвращает как `guardLog`.

**Защита по имени из снимка, а не по словам агента.** В вызове `browser_click` агент сам пишет
`element` («Next button») и указывает `target` — ref элемента из снимка. Если судить только
по `element`, агент может назвать Submit «Primary button», и запрет не сработает. Поэтому:

- **PostToolUse.** Хук разбирает ответ каждого инструмента Playwright (`plugins/agent-snapshot-refs.ts`).
  Из ARIA-снимка вида `- button "Submit application" [ref=f11e1300]` он берёт пары
  ref → роль, имя и текст потомков; текст потомков нужен для кнопок без имени.
  - Пары дописываются в `<runDir>/refs.json`; при повторе ref побеждает последнее значение.
  - После `browser_navigate`, `browser_tabs` или когда в ответе другая страница (по origin и пути
    `Page URL`) старые ref сбрасываются: на новой странице номера начинаются заново.
  - В `guard-log.jsonl` пишется строка `event: post` с адресом страницы, числом ref и ответом,
    обрезанным до 2000 символов.
  - PostToolUse ничего не блокирует. Если он упал, ref остаются неизвестными, и следующий клик
    по ним будет запрещён.
- **PreToolUse.** `browser_click`, `browser_type`, `browser_select_option` и поля `browser_fill_form`
  проверяются по реальной роли, имени и тексту ref из `refs.json`. Слова агента проверяются тоже:
  для клика — весь вызов, для ввода и выбора — только `element` (иначе ответ со словом «send»
  дал бы запрет). Любое совпадение с submit-словами означает submit.
  - Ref, которого не было ни в одном снимке этой попытки, или вызов без ref — запрет
    «Take browser_snapshot first: unknown element ref.».
  - Это действует **в обоих режимах**: попытка `submit` — новая папка `runs/`, и агент
    обязан снять снимок заново.
- **Submit-слова** (`submitWords`): submit, send, отправ, подать/подач, надісл, absenden, envoy,
  soumet, enviar, invia, verzend, verstur, indienen, wyślij — без учёта регистра.

| Вызов | `fill` | `submit` |
|---|---|---|
| `browser_click`, если в имени, роли или тексте ref **или** в словах агента есть submit-слово | запрет: «stop, report ready_to_submit» | разрешён **один раз** за попытку, второй — запрет |
| `browser_type` / `browser_select_option` / `browser_fill_form` на элемент с submit-словом | запрет | запрет |
| клик, ввод или выбор по ref, которого нет в снимках этой попытки (или без ref) | запрет: «Take browser_snapshot first» | запрет |
| `browser_press_key` с Enter (и любая другая клавиша) | запрет | запрет |
| `browser_type` с `submit: true` | запрет | запрет |
| `browser_navigate` / `browser_tabs` с `url` не `https://*.linkedin.com` | запрет: «report external» | запрет |
| `browser_file_upload` с путём вне `APPLY_UPLOAD_DIR` = `<AGENT_CWD>/files/` (после нормализации `..`); оригиналы в `/srv/agent-files/` тоже запрещены | запрет | запрет |
| `browser_file_upload`, когда `APPLY_UPLOAD_DIR` не задан | запрет | запрет |
| `StructuredOutput`, `ToolSearch` | разрешены | разрешены |
| инструмент не из списка разрешённых (`Bash`, `Read`, `Grep`, `browser_evaluate`, чужой MCP…) | запрет | запрет |

Разрешены: `browser_navigate`, `_snapshot`, `_click`, `_type`, `_fill_form`, `_select_option`,
`_file_upload`, `_wait_for`, `_take_screenshot`, `_tabs`, `_find`, а также два встроенных инструмента
`claude`, которые ничего не трогают; их аргументы не проверяются:

- `StructuredOutput` — через него `claude` отдаёт ответ по `--json-schema`. Без него ответ приходит
  без `structured_output`, хотя `subtype` равен `success`; это видно на живом прогоне 2026-11-04.
- `ToolSearch` — загружает схемы инструментов.

Тот же список уходит в `--allowedTools`, чтобы `dontAsk` их не отклонял. Запрещённые уходят
в `--disallowedTools`, среди них `Read`, `Grep` и `Glob`: на живом прогоне агент пытался прочитать
файл снимка в `~/.claude/projects`.

Хук устроен так, чтобы ошибка приводила к запрету, а не к пропуску вызова:

- если вход не разобран, нет папки попытки или скрипт упал внутри — он отвечает запретом; без `APPLY_UPLOAD_DIR` запрещена любая загрузка;
- если хук не смог даже запуститься, команда заканчивается на `|| exit 2`, и `claude` блокирует вызов;
- единственное нажатие Submit в режиме `submit` закрепляется созданием файла `submit-click`
  с флагом `wx`, поэтому два параллельных вызова не пройдут оба.

Слово `send` в регулярке даёт ложные запреты: так задумано, ложный запрет дешевле ложной отправки.
По той же причине клик по контейнеру, внутри которого есть кнопка Submit (текст потомков), тоже
запрещён.

Ограничение: имя элемента берётся из последнего снимка, где встречался этот ref. Если страница
поменяла подпись кнопки без смены адреса и без нового снимка, хук увидит старое имя.
Слова агента при этом всё равно проверяются.

### Блокировка браузера `plugins/browser-lock.ts`

`acquireBrowserLock({ task })` создаёт `server/data/browser.lock` флагом `wx` и пишет туда
`{ task, pid, startedAt }`.

- Если владелец lock жив, бросается `BrowserBusyError`: «браузер занят: collect с …, pid N».
- Lock мёртвого процесса или битый файл считается протухшим и забирается.
- `release()` удаляет файл, только если lock всё ещё наш.

Кто берёт lock:

- `npm run collect` — на весь прогон; если браузер занят, команда падает с кодом 1;
- `npm run cycle` — только на этап сбора; если браузер занят, сбор пропускается с этой причиной,
  а отбор идёт.
- Telegram-бот job-autopilot (`npm run bot`, [telegram.md](telegram.md)) — `/run collect` на весь прогон
  (`task: bot:collect`; занято — ответ «занято: браузер — …»), `cycle` — на этап сбора, как CLI.

Telegram-бот local-agent об этом lock не знает.

### Только Easy Apply

- У сохранённого поиска есть поле `easyApplyOnly`: миграция `20261104121217_searches_easy_apply`,
  `POST` и `PATCH /api/searches`. Для такого поиска `LinkedinParser.searchUrl` добавляет `f_AL=true`.
- Флаг `--easy-apply` у `collect` и `cycle` работает по-разному в зависимости от поиска:
  - при разовом поиске задаёт это поле;
  - при прогоне сохранённых включает фильтр для всех поисков на этот прогон и ничего не записывает в БД.

## Планы (не сделано)

- Бизнес-логика подачи, промпт `ApplicationRules.buildApplyPrompt`, `npm run apply`, запись
  `applications.result` с `guardLog`, лимиты бюджета на запуск и на день — пакет Г.
- Блокировка браузера в боте и в apply — пакеты Б и Г.
- Чистка старых папок `server/data/agent/runs/`.
- Живая проверка в режиме `fill` на одной Easy Apply вакансии и проверка, что подсунутый
  «press Submit» блокируется.
