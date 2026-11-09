# Сбор через агента — задача `hunt` ✅

Пока у биржи нет своего модуля-источника (как [LinkedIn](collector-plan.md)), её читает агент Claude:
`claude -p` на подписке пользователя (модель `HUNT_MODEL`, по умолчанию sonnet; DeepSeek не используется)
в общем agent Chromium через Playwright MCP. Агент только читает страницы; всё, что решает судьбу
вакансии (URL, повторы, фильтр, запись), делает код. Дальше вакансии идут обычным конвейером:
`recordFound` → двойники → оценка → Job-Tracker, как вакансии LinkedIn.

`hunt` — отдельная задача, не часть `cycle` (`cycle` по-прежнему собирает только LinkedIn).

## Как запустить

- Поиск: в боте `/search @indeed node.js | Ireland | +node | -java` (также `@djinni`, `@remoteok`,
  `@wellfound`, `@https://адрес-страницы-поиска`), по HTTP — `POST /api/searches` с
  `{"source": "agent", "site": "indeed", "keywords": "node.js", …}`. `/searches` показывает `@indeed «node.js» (Ireland)`.
- Бот: `/hunt` (`/run hunt limit=5 threshold=60 max=30`), расписание `/schedule hunt 0 8 * * *`, затем `/on hunt`.
- CLI:

  ```bash
  npm run hunt -- --user me@example.com --site djinni --query "node.js" --limit 3 --dry-run --skip-score   # проба
  npm run hunt -- --user me@example.com                                  # сохранённые поиски → оценка → JT
  npm run hunt -- --help
  ```

  `--limit` — описаний на поиск (1–50, по умолчанию 10), `--dry-run` — ничего не записывать (агент
  работает и тратит), `--skip-score` — без оценки, `--no-push`, `--threshold`, `--model`, `--max-minutes` — как у `cycle`.

## Как идёт один поиск

Код — [HuntService.ts](../server/src/searches/HuntService.ts), чистые шаги — [HuntRules.ts](../server/src/searches/HuntRules.ts),
сайты — [AgentSites.ts](../server/src/searches/AgentSites.ts).

1. **Выдача.** Агент получает адреса страниц выдачи (до 2) и подсказки сайта, открывает новую вкладку,
   читает список и возвращает по JSON-схеме до 20 карточек: `url`, `title`, `company`, `location`,
   `postedAt` (как на странице). Страницы вакансий в этом шаге не открываются.
2. **Код.** Канонический URL сайта; ссылка на чужой хост или не на страницу вакансии — `invalid`;
   повторы внутри прогона отбрасываются; `unknownUrls` оставляет только новые для владельца; фильтр
   по названию (`+слова`, `-слова`, правило то же, что у LinkedIn) — отсеянные сразу пишутся как
   `rejected` с причиной, чтобы не открывать их снова. Дата: «4d», «19d», «1mo», «4 days ago»,
   «updated 4d ago», «30+ days ago», «today», ISO — в `postedAt`, иначе пусто; текст даты — в `raw.postedAtText`.
3. **Описания.** Новый запуск агента (не `--resume`: у нового процесса своя MCP-сессия и своя вкладка,
   а короткий контекст дешевле) открывает страницы новых прошедших вакансий, не больше `limit`, и
   копирует описание **дословно** (до ~4000 символов; код режет до 4000). Возвращённое сверяется по
   каноническому URL: описание не из списка отбрасывается.
4. **Запись** — через `JobCollectorApi.recordFound`, как у сборщика: `source` — id сайта (`indeed`,
   `djinni`, `remoteok`, `wellfound`, у общего сайта — хост без `www.`), `externalId` — id вакансии
   сайта (у Indeed — `jk`), `raw: {via: "agent", site, postedAtText}`.

**Без описания вакансия не записывается** (оценке нужно описание): закрытая, нечитаемая или сверх
`limit` вакансия при следующем прогоне снова окажется новой, и агент спросит её ещё раз. Отсеянные по
названию записываются сразу и без описания.

Отчёт поиска пишется в `search_runs` (как у LinkedIn) с `described` и `costMicros`. Строка отчёта:

```
indeed «node.js»: карточек 20, новых 8, с описанием 8, отсеяно по названию 3, 3 мин, $0.40; записано 11
indeed: нужна капча/вход — пропущено
```

## Блокировки, браузер, вкладки

- **Капча, Cloudflare, стена входа** — агент не пытается их пройти и отвечает `accessible: false` с
  `blockedAt`. Поиск останавливается (`error`, «нужна капча/вход — …»), остальные поиски этого сайта в
  прогоне пропускаются (как `SourceStopError` у сборщика), другие сайты идут дальше.
- **Lock браузера.** Вся задача держит общий `server/data/browser.lock` (`hunt` в CLI, `bot:hunt` в боте).
  Занят — CLI падает с «браузер занят: …», бот отвечает «занято: браузер — …»; агент не запускается.
- **Вкладки.** Агент открывает новую вкладку и не закрывает её сам. До запуска код читает список вкладок
  (CDP `Target.getTargets` через Playwright MCP, [browser-tabs.ts](../server/plugins/browser-tabs.ts)), после —
  закрывает новые вкладки на хостах сайта и пустые. Id целей не меняются, если MCP-сессия оборвётся и
  индексы вкладок сдвинутся; чужая вкладка на другом сайте не трогается.
- **Агент недоступен** (нет `claude`, неверные настройки) — остальные поиски прогона не запускаются.

## Защита: режим `browse` хука

Тот же хук, что у подачи ([agent-runner.md](agent-runner.md)): `claude-agent.ts` пишет
`.claude/settings.json` с `scripts/agent-guard.ts` в PreToolUse и PostToolUse, режим — `APPLY_MODE=browse`,
хосты сайта — `APPLY_ALLOWED_HOSTS`. Правила — `browseDecision` в
[agent-guard-rules.ts](../server/plugins/agent-guard-rules.ts):

- инструменты только `browseTools`: `navigate`, `navigate_back`, `snapshot`, `click`, `type`, `press_key`,
  `wait_for`, `tabs` (плюс `StructuredOutput`, `ToolSearch`); `--allowedTools` / `--disallowedTools` те же;
  `evaluate`, `run_code_unsafe`, `fill_form`, `select_option`, `file_upload`, `take_screenshot`, `find` и т. п. запрещены;
- переход и новая вкладка — только https на хостах сайта (точное совпадение, без «уже посещённых»);
  если страница ушла на другой хост, читать и кликать нельзя — только назад или на сайт;
- клик запрещён, если настоящее имя элемента (из снимка; у безымянного — его текст) или слова агента
  содержат apply, submit, send, sign in/up, log in, register, subscribe, save job, post a job, continue with,
  upload, premium… (и русские/украинские/немецкие аналоги); значок «Easily apply» внутри карточки не мешает;
  неизвестный `ref` — запрет;
- ввод — только в поле поиска (`searchbox`, или текстовое поле с «search / keyword / where / location…» в имени),
  никогда в e-mail, пароль, телефон, имя; `submit: true` и Enter запрещены — выдача открывается по URL,
  а в поле поиска агент нажимает кнопку поиска;
- `browser_tabs`: только `new` и `list`; переключение и закрытие делает код.

## Сайты

| id | Хосты | Выдача | Страница вакансии (канон) |
|---|---|---|---|
| `indeed` | `www.indeed.com`, `ie.indeed.com` | `https://{ie\|www}.indeed.com/jobs?q=<q>&l=<l>` (ie — если в локации Ireland/Dublin/Cork…), стр. 2 — `&start=10` | `https://<host>/viewjob?jk=<16 hex>`; `jk` из `jk`, `vjk` или `fromjk` (у карточек нет ссылок) |
| `djinni` | `djinni.co`, `www.djinni.co` | `https://djinni.co/jobs/?all_keywords=<q>&remote_type=full_remote`, стр. 2 — `&page=2` | `https://djinni.co/jobs/<id>-<slug>/` |
| `remoteok` | `remoteok.com`, `www.remoteok.com` | `https://remoteok.com/remote-<tag>-jobs` (tag из ключевых слов без `.js`) | `https://remoteok.com/remote-jobs/remote-<slug>-<id>` |
| `wellfound` | `wellfound.com`, `www.wellfound.com` | `https://wellfound.com/role/r/<slug>` (удалённо) или `/role/l/<slug>/<город>`, стр. 2 — `?page=2` | `https://wellfound.com/jobs/<id>-<slug>` |
| https-адрес | только его хост | сам адрес; `{q}` и `{l}` в нём заменяются ключевыми словами и локацией, иначе агент ищет полем поиска сайта | URL без `#`, `utm_*`, `ref`, `gclid`, `fbclid`… |

Адрес страницы известной биржи (например, `https://ie.indeed.com/jobs?q=node&l=Cork`) сохраняется как есть и
открывается вместо шаблона, но канон URL — правила этой биржи. Подсказки сайта (контейнер списка и описания для
`browser_snapshot target`) — в поле `hints`: большие страницы (Remote OK ~60 тыс. символов) иначе не влезают.

## Лимиты и стоимость

| Переменная | По умолчанию | Что ограничивает |
|---|---|---|
| `HUNT_MODEL` | `sonnet` | модель агента |
| `HUNT_TIMEOUT_MS` | `480000` (8 мин) | один запуск агента (выдача или описания) |
| `HUNT_MAX_USD_PER_DAY` | `5` | затраты агента с 00:00 UTC по ценам Claude (`total_cost_usd`; на подписке условно), сумма `search_runs.costMicros` всех пользователей; проверяется перед каждым запуском агента |
| `limit` / `--limit` | 10 | описаний новых вакансий на поиск |
| — | 20 карточек, 2 страницы, 40 ходов на выдачу, 10 + 4 × N ходов на описания | `HUNT_MAX_CARDS`, `huntListTurns`, `huntDetailTurns` в `HuntRules.ts` |

Ориентиры (проба 2026-11-09 и живая проверка): выдача ~1 мин и $0.15–0.30 на сайт, описание ≈ 2–3 хода
≈ $0.03–0.05. `@djinni «node.js»` c `limit=3`: 20 карточек, 3 описания (1358–4000 символов), 2 запуска агента,
~1,5 мин, $0.30, без отказов хука, вкладки закрыты. В пробном прогоне (`--dry-run`) затраты не сохраняются.

Журналы запусков: `server/data/agent/hunt/runs/<id>/` (системный промпт, `guard-log.jsonl` — каждый вызов и решение хука).

## Как заменить сайт настоящим сборщиком

1. Написать `<Name>Source.ts` по контракту `JobSource` ([collector-plan.md](collector-plan.md)) с тем же
   `id` (`indeed`, `djinni`…) и тем же `canonicalUrl`, что у сайта в `AgentSites.ts`, и добавить его в
   `SearchSources.ts`. Тогда `jobs.source`, канонический URL и `externalId` совпадут, и уже найденные
   агентом вакансии не придут второй раз.
2. Перевести поиски: `source: agent, site: indeed` → `source: indeed` (новый поиск и удалить старый, или
   SQL-миграция `UPDATE searches SET source = site, site = NULL WHERE source = 'agent' AND site = 'indeed'`).
3. Убрать сайт из `agentSites` (или оставить для разовых проверок). Теперь его собирают `collect`/`cycle`.

## Код и тесты

| Файл | Что делает |
|---|---|
| `server/src/searches/AgentSites.ts` | сайты: адреса выдачи, хосты, канон URL, подсказки, общий сайт по адресу |
| `server/src/searches/HuntRules.ts` | промпты и схемы, разбор ответов, карточки, описания, даты, какие вкладки закрыть |
| `server/src/searches/HuntService.ts` | прогон поисков `agent`: блокировка сайта, дневной предел, запись, отчёт |
| `server/src/searches/HuntContracts.ts` | порты `HuntAgent`, `HuntTabs`, `HuntAgentError` |
| `server/plugins/agent-guard-rules.ts` | режим `browse` хука |
| `server/plugins/browser-tabs.ts` | вкладки через CDP-цели Playwright MCP |
| `server/framework/composition/create-hunter.ts` | сборка: плагин агента в режиме `browse`, вкладки, `JobService` |
| `server/scripts/hunt.ts`, `pipeline-tasks.ts` (`runHunt`), `pipeline-cli.ts` (`huntReportLine`) | CLI, общий с ботом прогон, строки отчёта |

`tests/hunt.test.ts` (без живых вызовов): шаблоны адресов и канон URL (Indeed `jk`/`vjk`/`fromjk`, чужой
хост), даты, решения хука `browse`, прогон с фейковым агентом на временной SQLite (выдача → `unknownUrls` →
фильтр → описания → `recordFound`, чужой URL, вакансия без описания, блокировка сайта, `limit`, дневной
предел, недоступный агент, `--dry-run`, вкладки), настройки и флаги CLI. `tests/bot.test.ts` — `/hunt`,
`/search @сайт`, расписание, отчёт; `tests/claude-agent.test.ts` — аргументы и хук режима `browse`;
`tests/searches.test.ts` — `site` в HTTP API.
