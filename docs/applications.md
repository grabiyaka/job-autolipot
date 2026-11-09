# Подача — домен `applications` и `npm run apply`

Агент (`claude -p` на DeepSeek с Playwright MCP, [agent-runner.md](agent-runner.md)) заполняет форму
LinkedIn Easy Apply **или форму на сайте компании / ATS** (Greenhouse, Lever, Ashby…) по профилю из Job-Tracker
и банку ответов и **останавливается перед отправкой**. Отправка идёт только после твоего ✅: кнопка в Telegram,
`--submit` в CLI или `POST /api/applications/:id/submit`. Без ✅ — только с `APPLY_AUTO_SUBMIT=true`
([автоотправка](#автоотправка-apply_auto_submittrue)). Сайты с аккаунтом (Workday, iCIMS, Taleo, SuccessFactors…)
агент заполняет, только если в браузере уже есть вход; аккаунты, пароли и капчу — никогда: попытка `manual`, ссылка тебе,
после подачи — «подал сам» (`--manual-applied`). Или аккаунт заводится с телефона в браузере агента
([удалённый браузер](telegram.md#удалённый-браузер-)), и по «✅ Аккаунт готов» агент заполняет вакансию заново.

Задание и решения: [phase3/d-applications.md](phase3/d-applications.md), [phase3/f-external-apply.md](phase3/f-external-apply.md)
(внешние сайты, пакет Е), [phase3/decisions.md](phase3/decisions.md).

Пакет Е в коде (домен, схема, промпт, CLI, бот, тесты на фейковом агенте) — сделан 2026-11-05; живого пилота
на внешних формах ещё не было (см. «Ещё не сделано»).

## Поток ✅

```
JT To Apply (GET /api/ai/jobs?evaluation=any, старые первыми, все страницы)
  └─ локальная вакансия: по trackerId → по URL (тогда связывается с JT) → иначе создаётся queued
       └─ берутся вакансии в found / scored / rejected / queued
            └─ адрес не https (и не linkedin.com/jobs/view/<id>) → попытка и вакансия manual «не https-ссылка», агент не запускается
            └─ вакансия applying, попытка running → агент mode=fill, startUrl = страница вакансии
                 (LinkedIn: Easy Apply — в диалоге; только Apply наружу — агент идёт по ней и заполняет форму там;
                  вакансия не с LinkedIn — агент начинает с её страницы)
                 ready_to_submit → попытка ready (ждёт ✅), kind easy_apply | external, applyUrl — страница формы;
                                   вакансия остаётся applying. Внешняя форма не на https → manual
                 needs_input     → вопросы open, вакансия needs_input
                 manual          → попытка и вакансия manual (аккаунт, вход, капча, Workday…; причина и applyUrl)
                 closed/not_eligible → вакансия skipped (причина в why)
                 blocked/failed/ошибка агента → вакансия failed
                 остановка (Ctrl+C, /stop) или агент недоступен → вакансия снова queued
✅ Easy Apply → агент mode=submit, --resume той же сессии
✅ external   → новый прогон mode=submit_fresh, startUrl = applyUrl (не --resume: вкладка формы к ✅ потеряна):
                 заполнить заново теми же ответами, сверяясь со сводкой полей прошлого заполнения, отправить один раз,
                 подтвердить по странице «спасибо»
                 needs_input (новый обязательный вопрос) → без отправки, вопросы open, вакансия needs_input
                 manual (аккаунт, капча) → попытка и вакансия manual; applyUrl не https → manual без запуска агента
       submitted → попытка submitted, вакансия applied → JT POST /api/ai/jobs/:id/application
manual → «подал сам» (--manual-applied, POST …/manual-applied) → попытка submitted, вакансия applied → JT (company_site_manual)
       «🖥 Открыть браузер» → аккаунт с телефона → «✅ Аккаунт готов» → fillNext(jobId, accountReady): старт на applyUrl попытки
       ❌ → попытка и вакансия skipped
```

## Автоотправка (`APPLY_AUTO_SUBMIT=true`)

По умолчанию выключена. Включённая меняет только заполнение (`fillNext`), ✅ для старых `ready` работает как раньше:

- агент запускается в режиме защиты `submit_fresh` (один разрешённый клик отправки за попытку; хосты, загрузки,
  Enter и всё остальное защита проверяет как прежде) с промптом `auto`: заполнить и отправить форму ровно один раз,
  подтвердить по «Application sent» / странице «спасибо»; на каждом шаге формы перед Next / Review / Submit —
  `browser_take_screenshot`. Схема ответа и исходы — как у `submit_fresh`;
- `submitted` → попытка `submitted` (`trackerChannel` по `kind`), вакансия `applied`, сразу отметка в JT (как после ✅);
  в отчёте `FillReport.submitted`: попытка с полями (`filled` — вопросы и ответы), файлы скриншотов, итог JT;
- обязательный вопрос без ответа → `needs_input` **без отправки**, вопросы в Telegram со ссылкой на форму;
- агент не подтвердил отправку, а защита пропустила клик отправки (в том числе при ошибке или остановке агента) →
  попытка и вакансия `failed` «отправка не подтверждена — проверьте: <ссылка>», заново **не** заполняется;
- скриншоты сохраняет хук ([agent-runner.md](agent-runner.md)) в `runs/<id>/screenshots/`, пути — в `applications.result`.

## Черновик

Попытка `needs_input` хранит поля, которые агент уже заполнил (`filled` в `applications.result`), и ссылку на форму
(`applyUrl`). Следующее заполнение этой вакансии получает поля последней такой попытки в `<previous_fill>` с правилом
«черновик прошлой попытки: используй эти значения, недостающее — из ответов» (`ApplicationRepository.latestDraft`).

Вакансии берутся по одной: браузер один, на весь прогон берётся lock `server/data/browser.lock`
(общий со сборщиком и ботом). Занят — ошибка «браузер занят: …».

## Статусы

Попытка (`applications.status`):

| Статус | Значит |
|---|---|
| `running` | агент работает |
| `ready` | форма заполнена, ждёт ✅ |
| `submitted` | отправлено, отметка в JT ещё не прошла (JT не ответил или 409) |
| `applied` | отправлено и отмечено в JT (или вакансии в JT уже нет в To Apply, или она не из JT) |
| `needs_input` | агент задал вопросы |
| `manual` | подать может только ты: аккаунт, вход, капча, Workday/iCIMS/Taleo/SuccessFactors без входа в браузере, ссылка не https; ссылка в `applyUrl` |
| `skipped` | вакансия закрыта, не проходит вопрос-фильтр, ❌ |
| `failed` | агент не справился, остановлен, ответ не по схеме |

Вакансия получает тот же `manual` (`JobStatus.manual`): из него — `applied` («подал сам»), `queued` (`--job`)
или `skipped` (❌).

Поля попытки: `kind` — `easy_apply` | `external` (вакансия не с LinkedIn — всегда `external`); `applyUrl` —
страница формы, где агент остановился (для Easy Apply — вакансия; агент не дал — страница вакансии);
`trackerChannel` — `channel` отметки в JT, задаётся при отправке. Сводка полей (`filled`: поле → значение)
лежит в ответе агента в `applications.result`.

Вопрос (`questions.status`): `open` → `answered` (ответ ушёл в банк) → `used` (следующее заполнение
вакансии началось с ним). Причина итога — в `applications.note`, ответ агента (поля, сводка, журнал
инструментов) — в `applications.result`.

## Правила агента

Системный промпт собирает `ApplicationRules.buildApplyPrompt` (основа — [phase3/c-agent-runner.md](phase3/c-agent-runner.md#системный-промпт-агента-из-пробы)):

- LinkedIn с Easy Apply — диалог Easy Apply; только Apply наружу — идти по ней и заполнять форму там; вакансия не
  с LinkedIn — начать с её страницы; ходить только по LinkedIn, сайту стартовой страницы, сайту, куда ведёт Apply,
  и известным ATS (защита [agent-runner.md](agent-runner.md) — то же самое и жёстко);
- сайты с аккаунтом (Workday, iCIMS, Taleo, SuccessFactors…): в браузере уже есть вход (видна форма или кабинет,
  а не вход/регистрация) — заполнять как любой сайт; иначе сразу `manual`. Регистрация, вход по паролю, подтверждение
  email, капча, нужен запрещённый сайт — `manual` с причиной в `summary` и `applyUrl`; вакансия закрыта — `closed`;
- `accountReady` (`FillOptions`, только с `jobId`; «✅ Аккаунт готов» в боте): владелец только что вошёл на сайт в браузере
  агента. Агент стартует с `applyUrl` последней `manual`-попытки (это и `startUrl` защиты), в задании — «форма, где владелец
  только что вошёл: … начни там», в промпте — «ожидай, что вход есть; всё ещё просят войти — `manual`». Других проверок
  «сразу manual» в коде нет: решение принимал только промпт (кроме не-https ссылок);
- отправка (Submit / Send / Apply после ввода) и Enter запрещены (и хуком тоже); на последнем шаге — `ready_to_submit`,
  во внешней форме — после заполнения всех полей;
- ответы только из профиля и банка; обязательное без ответа — `needs_input` со списком вопросов;
  необязательное — пусто; сопроводительное письмо — короткое, по профилю и вакансии, **только если поле обязательное**;
- обязательный вопрос-фильтр, на который правдивый ответ «нет» **однозначно** следует из профиля или банка
  (офис в другом городе, нет права на работу) — `not_eligible`, вакансия `skipped`; не однозначно — `needs_input`;
- email и телефон — из профиля; LinkedIn предзаполняет контакты: если в списке есть email из профиля или банка — выбрать его,
  иначе оставить и написать в `summary`; на других сайтах — вписать из профиля;
- согласие на обработку данных — только если разрешено банком; прочие заявления, оплата — `blocked`;
  аккаунты, пароли, капча — никогда (`manual`);
- резюме — путь копии из `agentUploadPath(APPLY_CV_FILE)` (`<AGENT_CWD>/files/…`), не ранее загруженный файл;
- страницу смотреть только `browser_snapshot` / `browser_find`, файловые инструменты (Read, Grep) запрещены;
- зарплата — правило из банка, а без него — по вилке вакансии, не ниже минимума профиля ([a-answers.md](phase3/a-answers.md#правило-по-зарплате));
- ответ — JSON по схеме: `outcome`, `summary`, `kind`, `applyUrl`, `filled` (поле → значение), `questions`
  (у `submit` с `--resume` — без `kind` и `applyUrl`).

Профиль, ответы и описание вакансии передаются в тегах `<profile>`, `<answers>`, `<job_posting>` с
экранированием `< > &`; URL вакансии LinkedIn в задании агенту пересобирается из числового id, прочие —
как их печатает `URL` (только https, без логина и `#`), ответ агента `applyUrl` проверяется так же.
Каждому прогону передаётся `startUrl` (хост, разрешённый защитой): страница вакансии, у `submit_fresh` — `applyUrl`.

Режим `submit` (Easy Apply) продолжает сессию заполнения (`--resume`) с тем же промптом, где вместо запрета —
«нажми Submit ровно один раз на шаге проверки». Режим `submit_fresh` (внешняя форма) — новый прогон
`buildSubmitFreshPrompt`: те же правила, профиль, банк и вакансия плюс `<previous_fill>` — сводка полей прошлого
заполнения; отправить ровно один раз (защита пропускает один submit-клик). Если агент не подтвердил отправку:
был разрешённый клик — вакансия `failed` («проверьте в LinkedIn» / «проверьте на сайте: <applyUrl>»), не было —
вакансия снова `queued` и заполнится заново. У `submit_fresh` клики идут и при заполнении, поэтому любой
разрешённый клик там значит «возможно, отправлено».

## Job-Tracker ✅

После отправки — `POST /api/ai/jobs/:trackerId/application` с `agentName: job-autopilot/deepseek`,
`appliedAt` — время отправки (или отметки «подал сам») и `channel`:

| Как подано | `channel` |
|---|---|
| Easy Apply агентом | `linkedin_easy_apply` |
| внешняя форма агентом (`submit_fresh`) | `company_site` |
| «подал сам» из `manual` | `company_site_manual` |

Ответы JT одинаковы для всех трёх:

| Ответ JT | Попытка |
|---|---|
| 201 `created`, 200 `already_applied` | `applied` |
| 404 (вакансию уже перевели вручную) | `applied`, пометка «уже нет в To Apply», не повторяется |
| 409 (неоднозначная компания, дубль) | остаётся `submitted`, причина в отчёте; разберите в JT |
| сеть, 5xx, 429 | остаётся `submitted` |

Попытки `submitted` отправляются в JT заново в начале каждого `npm run apply` / `/run apply`.
Вакансия в autopilot становится `applied` сразу после отправки, независимо от JT.

## Ответы на вопросы

Ответ (реплаем в Telegram, `--answer` или `POST /api/questions/:id/answer`) записывается в банк ответов
(`origin: telegram` или `manual`) по формулировке вопроса агента. Когда закрыт последний вопрос попытки,
вакансия снова `queued`: следующее заполнение начнёт форму заново (через часы старая сессия ненадёжна —
форма LinkedIn закрывается) с [черновиком](#черновик) и новым ответом в банке. Ответ реплаем в Telegram
запускает это заполнение сразу ([telegram.md](telegram.md#подача-)); CLI и HTTP — следующий `npm run apply` / `/run apply`.

## Лимиты

- `APPLY_MAX_PER_RUN` (по умолчанию 5) — запусков агента за один прогон (`--limit`, `limit=N` в боте);
  `manual` без агента (не https) не считаются.
- `APPLY_MAX_USD_PER_DAY` (по умолчанию 0.5) — сумма `applications.costMicros` попыток, начатых с 00:00 UTC;
  перед каждым запуском агента проверяется, превышено — прогон останавливается («дневной лимит затрат»).
  ✅ внешней формы (`submit_fresh`, стоит примерно как заполнение) тоже проверяет лимит: превышен — 409
  `APPLY_BUDGET_SPENT`, агент не запускается. Его стоимость добавляется к попытке (то есть к дню, когда она начата).
- Таймаут одного запуска — `APPLY_TIMEOUT_MS` плагина агента.
- Стоимость считает плагин по токенам и `DEEPSEEK_PRICE_*`; отправка добавляет свои токены к попытке.

## Команды ✅

```bash
npm run apply -- --user <email> [--limit N] [--job <id>]   # заполнить, стоп перед Submit
npm run apply -- --user <email> --list                     # что ждёт ✅, открытые вопросы, «подать вручную» со ссылками
npm run apply -- --user <email> --submit <applicationId>   # отправить и отметить в JT (внешняя форма — заполнить заново и отправить)
npm run apply -- --user <email> --reject <applicationId>   # отказаться (ready, needs_input, manual): skipped «отклонено вручную»
npm run apply -- --user <email> --manual-applied <applicationId>   # подал сам (только manual): applied, JT company_site_manual
npm run apply -- --user <email> --answer <questionId> "<ответ>"
npm run autoapply [-- --limit N] [--job <id>]   # автоподача: Claude на подписке заполняет и сразу отправляет, без ✅
```

`npm run autoapply` = `apply --auto --agent claude`: `--auto` — [автоотправка](#автоотправка-apply_auto_submittrue)
на этот прогон, `--agent claude` — агент `claude -p` на залогиненном аккаунте Claude (без DeepSeek, модель
`APPLY_CLAUDE_MODEL`), лимит дня — `APPLY_CLAUDE_MAX_USD_PER_DAY` (стоимость — `total_cost_usd` по прайсу API, на
подписке условная). Флаги можно и в `apply`. `--user` необязателен: `BOT_USER`, иначе единственный активный пользователь.

`--job` — id вакансии в autopilot или в JT; такую вакансию можно повторить и после `failed` / `skipped` / `manual`.

Telegram: `/run apply [limit=N]`, `/schedule apply <cron>`, `/pending`, кнопки ✅ / ❌, ответ реплаем на
вопрос — [telegram.md](telegram.md#подача-). У внешней формы бот показывает сводку полей перед ✅; `manual` —
сообщение со ссылкой и кнопками «✅ подал сам» / «❌ не подаю», они же в `/pending`.

HTTP (нужен вход, видны только свои записи, чужие — 404):

| Метод | Что |
|---|---|
| `GET /api/applications` | свои попытки, новые первыми |
| `GET /api/applications/:id` | попытка с полями и вопросами |
| `POST /api/applications/:id/submit` | отправить `ready` (не `ready` — 409); в HTTP-сервере агент читает настройки из `.env` при первом запуске |
| `POST /api/applications/:id/manual-applied` | «подал сам» для `manual` (иначе 409), отметка в JT `company_site_manual` |
| `POST /api/questions/:id/answer` | `{answer}` → банк, вопрос закрыт |

## Настройки

| Переменная | Значение |
|---|---|
| `APPLY_MAX_PER_RUN` | 5 |
| `APPLY_MAX_USD_PER_DAY` | 0.5 |
| `APPLY_CV_FILE` | имя файла резюме в `/srv/agent-files`; пусто — единственный PDF там |
| `APPLY_AUTO_SUBMIT` | `false`; `true` — [автоотправка](#автоотправка-apply_auto_submittrue) без ✅ |
| `APPLY_AGENT` | `deepseek` (по умолчанию) или `claude` — аккаунт Claude без `--settings`; `--agent` перекрывает |
| `APPLY_CLAUDE_MODEL` | `sonnet`; модель для `claude` |
| `APPLY_CLAUDE_MAX_USD_PER_DAY` | 10; дневной лимит для `claude` вместо `APPLY_MAX_USD_PER_DAY` |
| `JOB_TRACKER_URL`, `JOB_TRACKER_TOKEN` | обязательны: профиль и To Apply; токену нужен scope `ai:applications:write` |
| `DEEPSEEK_*`, `AGENT_CWD`, `PLAYWRIGHT_MCP_URL`, `APPLY_TIMEOUT_MS` | плагин агента, [agent-runner.md](agent-runner.md) |

## Код

| Файл | Что делает |
|---|---|
| `server/src/applications/ApplicationTypes.ts` | статусы, отчёты, `ApplicationApi` для бота и CLI |
| `server/src/applications/ApplicationContracts.ts` | порты `ApplyAgent`, `ApplyBrowser`, настройки |
| `server/src/applications/ApplicationRules.ts` | стартовый URL, промпты fill / submit / submit_fresh, схема ответа, исходы → статусы, channel JT, бюджет |
| `server/src/applications/ApplicationService.ts` | `fillNext`, `submit` (resume или submit_fresh), `markManualApplied`, `reject`, `answerQuestion`, повтор отметки в JT |
| `server/src/applications/ApplicationRepository.ts` | `applications`, `questions` по владельцу вакансии |
| `server/src/applications/ApplicationRoutes.ts`, `…Controller.ts` | HTTP |
| `server/framework/composition/create-applications.ts` | плагин агента как `ApplyAgent`, lock, путь резюме, сборка для CLI и бота |
| `server/scripts/apply.ts`, `apply-cli.ts` | CLI |
| `server/plugins/job-tracker.ts` | `listToApply`, `markApplied` (`channel` передаёт `TrackerService.markApplied`) |

Тесты (`tests/applications.test.ts`, `tests/bot.test.ts`) — на фейковом агенте и фейковом JT, без
`claude`, браузера и сети.

## Ещё не сделано 📝

- живая проверка удалённого браузера на настоящем Workday / iCIMS (регистрация с телефона → «✅ Аккаунт готов» → агент);
- живой пилот внешних форм ([f-external-apply.md](phase3/f-external-apply.md#пилот-до-кода-в-общем-потоке)):
  `fill` на 2–3 Greenhouse / Lever (iframe, загрузка резюме, стоимость), затем `submit_fresh` после явного «да, отправляй»;
- расход повторного заполнения по ✅ (`submit_fresh`) записывается в попытку и попадает в день её начала, а не
  в день ✅: дневной лимит его в этот день не видит;
- живая проверка на 5 вакансиях Easy Apply (заполнение, ✅, отметка в JT);
- живая проверка автоотправки (`APPLY_AUTO_SUBMIT=true`) на Easy Apply: отправка, скриншоты, отметка в JT;
- скриншоты: на 2026-11-06 `browser_take_screenshot` в агентском Chromium (Xvfb, `--enable-gpu-rasterization`)
  падает по таймауту 5 с, картинок нет; доходит ли картинка MCP до PostToolUse-хука `claude`, ещё не проверено вживую;
- колонки `screenshotBefore/After` не заполняются (пути скриншотов лежат в `applications.result`).
