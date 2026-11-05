# Как устроен job-autopilot

Главный документ, чтобы за вечер понять весь проект: зачем он, как идёт вакансия от LinkedIn
до списка To Apply, какой файл за что отвечает и что будет дальше. Состояние на 2026-11-03.
Практические команды и частые ошибки — в [guide.md](guide.md).

Обозначения: ✅ работает в коде, ⏳ в работе, 📝 план.

## 1. Зачем это

Искать работу долго и однообразно: открыть LinkedIn, пролистать выдачу, прочитать десятки
описаний, отсеять неподходящие, подать на остальные. job-autopilot делает это сам один-два
раза в день:

1. ✅ **Сбор.** Читает выдачу LinkedIn через уже залогиненный браузер и сохраняет новые вакансии.
2. ✅ **Отбор.** Локальная модель (qwen на Ollama) сравнивает каждую вакансию с профилем кандидата
   и ставит оценку 0–100. Подходящие (≥ 50) становятся `queued`.
3. ✅ **Передача в Job-Tracker.** Отобранные вакансии вместе с оценкой уходят в список To Apply
   приложения [Job-Tracker](trackers.md) (JT), где человек ведёт свой поиск работы.
4. ✅ **Подача.** Агент заполняет форму LinkedIn Easy Apply из To Apply и останавливается перед Submit;
   отправка — после твоего ✅, затем отметка APPLIED в JT (⏳ живая проверка).
5. ✅ **Telegram и расписание.** Бот запускает сбор, оценку и заполнение вручную и по cron, присылает
   отчёт, показывает статус и банк ответов, формы с ✅ / ❌ и вопросы агента (ответ реплаем).

Итог сейчас: одна команда сбора и одна команда оценки (или бот по расписанию) превращают выдачу
LinkedIn в короткий список оценённых вакансий в JT; `npm run apply` (или `/run apply`) заполняет формы
из него, а отправляет их твоё ✅.

Почему локальная модель не ищет сама: железо — GTX 1060 6GB и 16GB RAM, то есть модели на 3–4B.
Страница LinkedIn — 10–50 тысяч токенов, и модель такого размера в многошаговой работе с браузером
теряет цель. Поэтому собирает детерминированный скрипт, а модель решает узкую задачу: сравнить
текст вакансии с профилем. Подробнее — в [README](../README.md#почему-поиск-не-делает-локальная-модель).

## 2. Конвейер целиком

```
 LinkedIn (выдача и страницы вакансий)
     │  только чтение: брокер agent Chromium, Unix-сокет /run/agent-browser/broker.sock
     ▼
 ┌─ 1. Сбор ✅ ─────────────── npm run collect ───────────────────────────────┐
 │  выдача → фильтр по названию → страница вакансии (компания, описание)       │
 │  неподходящее название → rejected (страница не открывается)                 │
 └──────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
                SQLite autopilot: server/data/job-autopilot.db
                таблица jobs, статус found
                                │
 ┌─ 2. Отбор ✅ ──────────────── npm run score ─────────────────────────────────┐
 │  профиль кандидата  ◀── GET /api/ai/profile-context (JT, кеш по ETag)        │
 │  повтор (та же компания + название)? → skipped, модель не спрашиваем         │
 │  иначе Ollama (локальная qwen): профиль + вакансия → {score, why, redFlags}   │
 │  score ≥ 50 → queued, иначе → rejected                                        │
 └──────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
 ┌─ Передача в JT ✅ ─── в конце npm run score (или POST /api/tracker/push) ────┐
 │  queued без trackerId → POST /api/ai/jobs/batch → To Apply                   │
 │  оценка → PATCH /api/ai/jobs/:id/evaluation                                  │
 │  JT: «уже есть» / «уже подавался» → skipped                                  │
 └──────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
                Job-Tracker: Postgres JT, список To Apply
                                │
 ┌─ 3. Подача ✅ ──── DeepSeek (claude -p) + Playwright MCP, «стоп перед Submit» ┐
 └──────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
 ┌─ 4. Telegram ✅ ── запуск 1–3 вручную и по cron, отчёт, ✅/❌, вопросы агента ┐
 └───────────────────────────────────────────────────────────────────────────────┘
```

Всё это одной командой — `npm run cycle` ([scripts/cycle.ts](../server/scripts/cycle.ts)): сбор, затем
отбор всех `found` (и новых, и оставшихся с прошлых прогонов), затем отправка в JT. Отдельно этапы
запускаются `npm run collect` и `npm run score`. Те же прогоны запускает Telegram-бот (`npm run bot`):
командой `/run` или по расписанию ([telegram.md](telegram.md)).

### Где живут данные

| Хранилище | Что там | Кто главный |
| --- | --- | --- |
| SQLite autopilot (`DATABASE_URL`, по умолчанию `server/data/job-autopilot.db`) | все найденные вакансии со статусами, оценками и причинами; сохранённые поиски и отчёты прогонов; копия профиля из JT; пользователи и сессии | главный источник по вакансиям и их статусам |
| Postgres Job-Tracker | профиль кандидата, список To Apply, подачи (Applications), оценки вакансий | главный по профилю и по тому, что человек решил делать с вакансией |

Копии в обе стороны:

- `tracker_profiles` в SQLite — копия профиля JT (markdown, ревизия, ETag). Её используют, когда JT
  недоступен.
- В JT попадает копия только `queued`-вакансий: название, компания, URL, описание, локация, источник,
  `externalId`, дата публикации и оценка. `rejected`, `skipped`, `found` и `raw` туда не уходят.
- Связь записей — поле `jobs.trackerId` (ID записи To Apply в JT). Пустое — вакансия ещё не отправлена.

## 3. Жизнь одной вакансии

Пример. В выдаче «node.js / Remote» есть три карточки:

1. «Senior DevOps Engineer». Сбор: в названии слово `devops` из `--exclude` → сразу **`rejected`**
   с причиной в `why`, страница вакансии не открывается.
2. «Lead Fullstack Engineer (TypeScript/Node.js)» — Blexity. Сбор: название прошло фильтр, страница
   открыта, взяты компания, локация и описание → **`found`**. Отбор: модель дала 82 → **`scored`**,
   затем **`queued`**. Передача: JT создал запись → вакансия получает `trackerId` и остаётся `queued`.
3. Та же вакансия Blexity под другим LinkedIn id (другая страна). Отбор: `findTwin` находит пункт 2
   по компании и названию → **`skipped`** с причиной «повтор: …», модель не вызывается.

Все переходы заданы таблицей `transitions` в [JobService.ts](../server/src/jobs/JobService.ts):

| Из | Можно в | Кто и когда |
| --- | --- | --- |
| — | `found` | сборщик (`recordFound`): название прошло фильтр, страница прочитана |
| — | `rejected` | сборщик: название не прошло `--include` / `--exclude` |
| `found` | `scored` | scorer (`recordScore`): модель дала оценку |
| `found` | `queued`, `rejected`, `skipped` | человек (`PATCH /api/jobs/:id`) или scorer (`recordDecision`, повтор → `skipped`) |
| `scored` | `scored`, `queued`, `rejected`, `skipped` | scorer сразу после оценки: ≥ порога → `queued`, иначе `rejected`; человек |
| `rejected` | `scored`, `queued`, `skipped` | человек может вернуть отсеянную в очередь |
| `queued` | `rejected`, `skipped` | человек; трекер-сервис ставит `skipped`, если JT ответил «уже есть» или «уже подавался» |
| `found`, `scored`, `rejected` | `queued` | applier: вакансия есть в JT To Apply ([applications.md](applications.md)) |
| `queued` | `applying` | applier (`recordApplyStatus`) |
| `applying` | `applied`, `needs_input`, `failed` | applier: отправлено после ✅, нужен ответ, агент не справился |
| `applying` | `queued`, `skipped` | **только applier**: прогон остановлен / форма заполняется заново; внешняя подача, закрыта, ❌ |
| `needs_input` | `queued`, `applying`, `skipped` | applier: на все вопросы ответили → `queued`; ❌ → `skipped` |
| `failed` | `queued`, `skipped` | человек |
| `skipped` | `queued` | человек |
| `applied` | — | финальный |

Человек вручную ставит только `queued`, `rejected` и `skipped`. Изменение статуса условное: если
другой процесс успел поменять статус, запрос получает 409 `JOB_STATUS_CHANGED`. В прогоне оценки такая
вакансия печатается как «~ статус сменился» и остаётся как есть.

Отправка в JT статус не меняет: признак «отправлена» — это `trackerId`, а не отдельный статус.

## 4. Этапы подробно

### 4.1. Сбор ✅

Команда `npm run collect` ([scripts/collect.ts](../server/scripts/collect.ts)), домен
[server/src/searches](../server/src/searches), подробности — [collector-plan.md](collector-plan.md).

Что происходит за один прогон поиска:

1. Модуль LinkedIn открывает классическую выдачу (свежие сначала, `skipRedirect=true`) и прокручивает
   список по одному экрану, после каждого шага сливая новые ссылки `/jobs/view/<id>/` (`mergeCards`):
   список виртуализирован, и большой прокруткой середина пропускается. Стоп — 25 карточек, 2 чтения
   без новых или 8 шагов. Следующая страница — тот же поиск с `start` + 25, всего до 4 страниц (до 100
   вакансий на запрос), пауза между страницами 6–12 с (`limits` в [LinkedinSource.ts](../server/src/searches/LinkedinSource.ts)).
   Если LinkedIn всё же увёл на новый AI-поиск `/jobs/search-results/` (в нём нет ссылок на вакансии),
   поиск останавливается с `SourceStopError`.
2. `JobService.unknownUrls` отбрасывает уже известные пользователю URL. Если новых нет — остановка `known`.
3. **Фильтр по названию** (`titleRejection` в [SearchRules.ts](../server/src/searches/SearchRules.ts))
   до открытия страницы. Почему: открыть страницу — это ~8 с и лишнее действие в живом аккаунте
   LinkedIn, а «Java Developer» при поиске Node.js отсекается по названию надёжно. Отсеянная сохраняется
   как `rejected` с причиной, поэтому следующий прогон её узнаёт, а человек может вернуть её в очередь.
   Слова ищутся целиком без учёта регистра: `java` не задевает «JavaScript».
4. Прошедшие открываются по одной (пауза 4 с), парсер [LinkedinParser.ts](../server/src/searches/LinkedinParser.ts)
   берёт компанию, локацию, описание и признак Easy Apply (в `raw`). Сохраняются как `found`.
5. Причины остановки: `end`, `known`, `limit`, `aborted` (Ctrl+C или `--max-minutes`), `error`.
   Для сохранённых поисков отчёт пишется в `search_runs`.
6. Время (оценка по паузам в коде): до ~15 минут на запрос без фильтра — до 100 открытий страниц
   по 4 с паузы плюс ~4–5 с загрузки; фильтр по названию сокращает это пропорционально отсеянным.

Ключевые решения:

- **Брокер только читает.** Сборщик не запускает свой браузер, а ходит в общий agent Chromium через
  брокер ([plugins/browser-broker.ts](../server/plugins/browser-broker.ts)): открыть URL, прочитать
  текст и ссылки, прокрутить. Кликать, вводить и отправлять формы он не умеет, поэтому сбор не может
  ничего сделать от имени аккаунта. Страница входа, authwall или checkpoint останавливает поиск.
- **Дедупликация** в БД по `(userId, url)` и `(userId, source, externalId)`. Модуль источника сам
  убирает свои трекинг-параметры, домен срезает `#фрагмент`.
- **Модуль сайта не знает о пользователях и БД** — только превращает запрос в страницы карточек.
  Новый сайт — файл `<Name>Source.ts` и строка в [SearchSources.ts](../server/src/searches/SearchSources.ts).

### 4.2. Отбор ✅

Команда `npm run score` ([scripts/score.ts](../server/scripts/score.ts)), домен
[server/src/scoring](../server/src/scoring): `ScoringService.ts` (прогон), `ScoringRules.ts`
(промпт, схема, разбор ответа, решение — без I/O), `ScoringContracts.ts` (интерфейс модели).
Модель подключается через [plugins/ollama.ts](../server/plugins/ollama.ts).

Прогон для одного пользователя (`ScoringService.scoreFound`):

1. Профиль из JT (`TrackerApi.profile`). Нет профиля — прогон пользователя не начинается
   (`stopped: profile`); не привязанный к JT пользователь печатается как «пропущен».
2. `listForScoring`: вакансии в `found` с описанием, старые первыми (`--limit` ограничивает число).
3. Для каждой: сначала проверка повтора, затем модель, затем решение.
4. В конце, если не `--dry-run`, не `--no-push` и не Ctrl+C, — отправка в JT (раздел 4.3).

Ключевые решения:

- **Профиль доверенный, вакансия — нет.** Профиль (markdown из JT) идёт в system-сообщение внутри
  `<profile>…</profile>`. Текст вакансии со сторонней доски — только в user-сообщение, как JSON внутри
  `<job_posting>…</job_posting>`. В обоих `<` и `>` экранированы, поэтому вакансия не может закрыть
  разделитель и выдать себя за правила. Инструкция модели прямо говорит: текст вакансии — данные,
  а попытку командовать надо занести в `redFlags`. Модель выдаёт только оценку; решение
  `queued`/`rejected` принимает код (`decideByScore`).
- **`think: false`, JSON-схема, температура 0.** Ollama получает `format` = `SCORE_SCHEMA` (поля
  `score`, `why`, `redFlags`, `matchedSkills`, `missingSkills`, без лишних), режим рассуждений
  выключен: нужен только JSON по схеме. Ответ дополнительно проверяет `parseScore`: целый score 0–100,
  непустой `why`, списки строк (до 5 пунктов по 200 символов, `why` — до 500).
- **Повтор при битом JSON.** Если ответ не разобрался, запрос повторяется один раз. Вторая неудача —
  строка «! ошибка», вакансия остаётся `found` и попадёт в следующий прогон.
- **Проверка обрезки промпта.** Ollama молча обрезает промпт длиннее `num_ctx` и может выкинуть
  правила из начала. Поэтому ответ отклоняется, если `prompt_eval_count > num_ctx − num_predict`
  (8192 − 1024 по умолчанию) или `done_reason` не `stop`. Описание длиннее 6000 символов обрезается
  заранее и помечается `descriptionTruncated`. Запас небольшой: профиль из JT сейчас ~13,5 КБ markdown
  (~3,5 тысячи токенов) при `num_ctx` 8192, и вместе с правилами и описанием до 6000 символов промпт
  может подойти к пределу 7168 — тогда помогает `OLLAMA_NUM_CTX` больше или профиль короче.
- **Недоступная модель останавливает весь прогон.** Сервер Ollama не отвечает, таймаут или HTTP-ошибка
  (чаще всего 404 «модель не скачана») — следующие запросы упадут так же, поэтому прогон
  останавливается (`model_unavailable`, код выхода 1), а не превращает все вакансии в ошибки.
- **Порог 50 и шкала.** В промпте: 80–100 сильное совпадение, 50–79 стоит подаваться, 35–49 частичное,
  не стоит, 0–34 не подходит. `SCORE_THRESHOLD = 50` в [ScoringRules.ts](../server/src/scoring/ScoringRules.ts),
  флаг `--threshold` меняет его на прогон. Порог снижен с 70 до 50 по решению пользователя; результаты
  живого прогона — в [guide.md](guide.md#какую-модель-брать--сравнение-на-живых-данных).
  Verdict для JT считается отдельно (`trackerVerdict` в [TrackerService.ts](../server/src/trackers/TrackerService.ts))
  и не менялся: ≥ 80 `STRONG_FIT`, 70–79 `GOOD_FIT`, 50–69 `WEAK_FIT`, < 50 `NOT_A_FIT`. Поэтому
  `queued` с оценкой 50–69 приходят в JT как `WEAK_FIT`.
- **Склейка повторов.** LinkedIn публикует одну вакансию под разными id для разных стран. Ключ повтора —
  компания + название без учёта регистра, пробелов и пунктуации (`twinKey` в
  [JobTypes.ts](../server/src/jobs/JobTypes.ts), им пользуются `JobService` и `ScoringService`).
  Двойником считается другая вакансия, которая: в `scored`, `queued`, `applying`, `applied`, `needs_input`;
  или `rejected` с оценкой (отклонила модель); или уже отправлена в JT (`trackerId`). Отсеянная фильтром
  по названию (`rejected` без оценки) двойником не считается. Повтор получает `skipped` с причиной
  «повтор: …» без вызова модели. В `--dry-run` БД не пишется, поэтому повторы внутри прогона ловит
  ещё и память прогона.
- **`profileRevision`.** К каждой оценке сохраняется ревизия профиля JT, по которой она поставлена.
  JT по ней видит устаревшие оценки.

Модель по умолчанию — `qwen3.5:4b` (`defaultOllamaConfig` в [ollama.ts](../server/plugins/ollama.ts),
`OLLAMA_MODEL` в `.env.example`). Другую можно взять на один прогон флагом `--model`.

### 4.3. Передача в Job-Tracker ✅

Домен [server/src/trackers](../server/src/trackers), HTTP-клиент
[plugins/job-tracker.ts](../server/plugins/job-tracker.ts), подробности — [trackers.md](trackers.md).

`TrackerService.pushQueued` за один вызов:

1. **Досылка оценок.** Читает у JT список его записей без оценки (`GET /api/ai/jobs?evaluation=none`,
   по страницам). Для каждой ищет свою вакансию по `trackerId`; если у неё есть score и `profileRevision`,
   отправляет оценку. Не больше 50 за прогон. Так закрывается случай, когда JT создал запись, но оборвался
   (например, 429) до приёма оценки: источником правды служит JT, а не локальный флаг.
2. **Одна пачка** до 50 `queued` без `trackerId` → `POST /api/ai/jobs/batch`.
3. По каждому результату: `created` → оценка (`PATCH …/evaluation`) и `trackerId`;
   `duplicate_opportunity` → `skipped` «уже в Job-Tracker»; `already_applied` → `skipped` «уже подавался»;
   `invalid` → остаётся `queued`, ошибки в отчёте.

Почему одна пачка: у JT лимит 60 запросов в минуту на токен, и каждая созданная запись стоит ещё
один запрос на оценку. Остаток (`remaining`) уйдёт следующим прогоном. Клиент JT не повторяет запросы:
оценка в JT дописывается, а не заменяется, и повтор создал бы дубль.

JT сам проверяет повторы: по нормализованному URL, по `source` + `externalId` и по компании + названию;
если по URL найдена подача (Application) — `already_applied`.

**Кеш профиля и ETag.** `profile()` отправляет сохранённый ETag (`If-None-Match`). 304 — обновляется
только `fetchedAt`. Новый профиль — сохраняются markdown, ревизия и ETag. JT недоступен или 429 —
используется копия (`fromCache: true`); копии нет — ошибка `TRACKER_UNAVAILABLE` /
`TRACKER_RATE_LIMITED`. Отказ по токену (401/403) копией не прикрывается: `TRACKER_UNAUTHORIZED`.

### 4.4. Telegram и расписание ✅, подача ✅

**Telegram-бот** (`npm run bot`, [telegram.md](telegram.md)) — отдельный долгоживущий процесс. Он
отвечает только `TELEGRAM_CHAT_ID` и работает от имени одного владельца (`BOT_USER` или единственный
активный пользователь). Задачи `collect`, `score` и `cycle` выполняются в процессе бота через те же
сервисы и общий модуль `scripts/pipeline-tasks.ts`, что и CLI. Одновременно идёт только одна задача,
а для браузера бот берёт тот же lock, что и CLI. `/stop` останавливает задачу через `AbortController`.

**Расписание** — домен `schedules`: таблица `schedules` (одно расписание на задачу, cron и часовой
пояс, по умолчанию `Europe/Dublin`; новое выключено до `/on`) и история запусков `task_runs`
(`manual`/`schedule`, `running → ok | error | aborted`, `busy`). Ближайший запуск считает `croner`.
Бот держит один таймер; пропущенные, пока он был выключен, запуски не догоняются.

**Подача** — домен `applications` ([applications.md](applications.md)): вакансии из JT To Apply по одной,
агент (`claude -p` на DeepSeek + Playwright MCP, [agent-runner.md](agent-runner.md)) заполняет форму
LinkedIn Easy Apply и останавливается перед Submit. Попытка — строка `applications`
(`running → ready → submitted → applied`, или `needs_input` / `skipped` / `failed`, сессия агента, токены
и стоимость), вопросы агента — `questions` (`open → answered → used`), ответы на них идут в `answers`.
Отправка — только после ✅ (`npm run apply -- --submit`, кнопка в боте, HTTP), затем отметка APPLIED в JT.
Лимиты — запусков агента за прогон и $ в сутки. В боте: `/run apply`, расписание `apply`, ✅ / ❌, ответ
реплаем на вопрос.

## 5. Карта кода

### Как устроен домен

Каждый домен — плоская папка `server/src/<домен>` из четырёх основных файлов:

```
*Routes.ts → *Controller.ts → *Service.ts → *Repository.ts
 маршруты     HTTP-ввод →      сценарии,      Prisma-запросы,
 и схемы      сервис → ответ   типы, правила  всегда по владельцу
```

- Типы и статусы домена живут в сервисе. `*Types.ts` — единственная дверь для других доменов
  (например, scoring видит jobs только как `JobPipelineApi`).
- `*Rules.ts` — чистые предметные правила без I/O, Prisma и Fastify; `*Contracts.ts` — интерфейсы,
  которые домен ждёт от внешнего мира.
- DI явный: репозиторий передаётся в конструктор сервиса. Конкретные классы собирает только
  `framework/composition`. Контроллеры не получают репозитории.
- Каждый метод получает владельца (`Actor` или `ownerId`) и фильтрует по нему: чужая вакансия
  ведёт себя как несуществующая (404).

Зачем так: бизнес-слой читается без инфраструктуры, тестируется с фейками (фейковая модель, фейковый JT),
а границы проверяются автоматически. `npm run architecture`
([scripts/check-architecture.ts](../server/scripts/check-architecture.ts)) разбирает импорты и запрещает,
например, Fastify вне Routes/Controller и импорт чужого домена мимо `*Types.ts`. Подробно —
[architecture.md](architecture.md).

### server/src

| Файл | За что отвечает |
| --- | --- |
| **users/** | |
| `UserRoutes.ts`, `UserController.ts` | `/api/auth/*`: регистрация, вход, выход, `me`; cookie сессии |
| `UserService.ts` | сценарии входа и сессий; `profile(userId)` — активный пользователь для трекера |
| `UserRepository.ts` | пользователи и сессии в Prisma |
| `UserTypes.ts` | `UserApi`, `UserProfile`, `UserSession` — граница для других доменов |
| `UserContracts.ts` | интерфейс репозитория пользователей |
| `UserRules.ts` | требования к паролю, имени и роли |
| `UserEmail.ts` | нормализация и проверка email |
| **jobs/** | [jobs.md](jobs.md) |
| `JobRoutes.ts`, `JobController.ts` | `/api/jobs`: список, сводка, карточка, ручное добавление, смена статуса, удаление |
| `JobService.ts` | таблица переходов, проверка URL, поиск двойника, все сценарии HTTP и конвейера |
| `JobRepository.ts` | Prisma-запросы с фильтром по владельцу, условное обновление статуса |
| `JobTypes.ts` | `JobPipelineApi`, `JobCollectorApi`, `PipelineJob`, `JobInput`, `JobScore`, статусы, `twinKey` |
| **searches/** | [collector-plan.md](collector-plan.md) |
| `SearchRoutes.ts`, `SearchController.ts` | `/api/searches`: сохранённые поиски, источники, история прогонов |
| `SearchService.ts` | CRUD поисков и ядро прогона: страницы, дедуп, фильтр, паузы, лимиты, отчёт |
| `SearchRules.ts` | проверка полей поиска, слова фильтра, `titleRejection`, задержки |
| `SearchRepository.ts` | `searches` и `search_runs` |
| `SearchTypes.ts` | контракт модуля сайта (`JobSource`, `Browser`, `HttpClient`) и ошибки браузера |
| `SearchSources.ts` | реестр источников (сейчас только LinkedIn) |
| `LinkedinSource.ts` | модуль LinkedIn: выдача, прокрутка, страница вакансии, остановка на стене входа |
| `LinkedinParser.ts` | разбор URL, ссылок и текста LinkedIn без браузера |
| **scoring/** | раздел 4.2; HTTP-маршрутов нет, только CLI |
| `ScoringService.ts` | прогон оценки пользователя: профиль, повторы, модель, решения, отчёт, вызов отправки в JT |
| `ScoringRules.ts` | промпт, `SCORE_SCHEMA`, `parseScore`, порог, `decideByScore`, причина повтора |
| `ScoringContracts.ts` | интерфейс `ScoringModel` и `ScoringModelUnavailableError` |
| **trackers/** | [trackers.md](trackers.md) |
| `TrackerRoutes.ts`, `TrackerController.ts` | `/api/tracker/status`, `/api/tracker/profile`, `/api/tracker/push` |
| `TrackerService.ts` | привязка по email, кеш профиля, отправка пачки, досылка оценок, verdict |
| `TrackerRepository.ts` | таблица `tracker_profiles` |
| `TrackerTypes.ts` | `JobTrackerClient`, `TrackerError`, `TrackerApi` для scoring, `TrackerApplyApi` (To Apply, отметка APPLIED) для подачи, отчёт отправки |
| **answers/** | банк ответов, [guide.md](guide.md#банк-ответов--npm-run-answers) |
| `AnswerRoutes.ts`, `AnswerController.ts` | `/api/answers`: список, запись (`PUT`, по ключу вопроса), удаление |
| `AnswerService.ts` | сценарии владельца (`list`, `put`, `remove`) и `AnswerApi` для подачи и бота |
| `AnswerRules.ts` | `answerKey` — ключ вопроса (NFKC, без шума и пунктуации, слова по алфавиту), проверка полей |
| `AnswerRepository.ts` | таблица `answers`, upsert по `(userId, key)` |
| `AnswerTypes.ts` | `AnswerApi` (`listForUser`, `upsert`), `Answer`, `answerOrigins` |
| **applications/** | подача, [applications.md](applications.md) |
| `ApplicationRoutes.ts`, `ApplicationController.ts` | `/api/applications`, `/api/applications/:id`, `…/:id/submit`, `/api/questions/:id/answer` |
| `ApplicationService.ts` | `fillNext` (To Apply → агент → попытка), `submit` (после ✅, затем JT), `reject`, `answerQuestion`, повтор отметки в JT, лимиты |
| `ApplicationRules.ts` | кандидаты Easy Apply, промпт агента с экранированием, схема ответа, исходы → статусы, бюджет за сутки |
| `ApplicationRepository.ts` | таблицы `applications` и `questions`, всегда по владельцу вакансии |
| `ApplicationContracts.ts` | порты `ApplyAgent` (агент) и `ApplyBrowser` (lock), настройки подачи |
| `ApplicationTypes.ts` | `ApplicationApi` для бота и CLI, статусы, отчёты |
| **schedules/** | расписание бота, [telegram.md](telegram.md); HTTP-маршрутов нет |
| `ScheduleService.ts` | расписания владельца (создать или заменить, вкл/выкл, удалить, ближайший запуск) и история `task_runs` |
| `ScheduleRules.ts` | задачи `collect`/`score`/`cycle`/`apply`, флаги задачи, 5 полей cron, часовой пояс по умолчанию |
| `ScheduleRepository.ts` | таблицы `schedules` и `task_runs` |
| `ScheduleTypes.ts` | порт `CronCalendar` (`check`, `next`), его реализует плагин `cron.ts` |

### server/plugins — техника

| Файл | За что отвечает |
| --- | --- |
| `environment.ts` | читает `../.env`; `ollamaConfigFromEnv`, `jobTrackerConfigFromEnv`, `claudeAgentConfigFromEnv`, `applySettingsFromEnv` |
| `database.ts` | Prisma Client для SQLite из `DATABASE_URL` |
| `infrastructure.ts` | Prisma, часы и генератор ID для веб-сервера |
| `browser-broker.ts` | клиент брокера agent Chromium (только чтение) |
| `http.ts` | fetch с таймаутом, User-Agent и повторами для источников |
| `ollama.ts` | клиент Ollama `/api/chat`: JSON-схема, `think: false`, проверка обрезки, один повтор |
| `job-tracker.ts` | клиент AI API JT: Bearer-токен, ETag, пачки, оценки, To Apply, отметка APPLIED (`markApplied`: 404/409 — результат, не ошибка); без повторов |
| `claude-agent.ts` | запуск `claude -p` на DeepSeek с Playwright MCP: аргументы, таймаут, токены и стоимость ([agent-runner.md](agent-runner.md)) |
| `agent-guard-rules.ts` | чистые правила хука агента `guardDecision`: что запрещено в `fill` и `submit` |
| `browser-lock.ts` | файловая блокировка agent Chromium `server/data/browser.lock` («браузер занят: …») |
| `telegram.ts` | клиент Bot API на fetch: `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`; повтор по `retry_after` на 429; токена нет в ошибках |
| `cron.ts` | `CronCalendar` на croner: проверка выражения и часового пояса, следующий запуск |
| `passwords.ts` | хеширование паролей (scrypt) |
| `client.ts` | раздача собранного Vue-клиента |
| `system-routes.ts` | `GET /api/health`: API и БД живы |

### server/framework/composition — сборка

| Файл | За что отвечает |
| --- | --- |
| `create-application.ts` | все сервисы веб-сервера: users, jobs, searches, trackers, answers, applications |
| `register-domain-routes.ts` | регистрирует маршруты шести HTTP-доменов |
| `create-applications.ts` | подача: плагин агента как `ApplyAgent` (настройки читаются при первом запуске), lock браузера, путь резюме, сборка для CLI и бота |
| `create-collector.ts` | сборщик для CLI: `SearchService` + `JobService` + брокер; `pingBrowser` — жив ли брокер |
| `create-searches.ts` | `SearchService` с источниками, браузером и HTTP-клиентом |
| `create-scorer.ts` | оценщик для CLI: `ScoringService` + `TrackerService` + Ollama; ошибки Ollama «сервер/HTTP» → `ScoringModelUnavailableError` |
| `create-trackers.ts` | `TrackerService` с клиентом JT или без него (`null` — «не настроен») |
| `create-answers.ts` | банк ответов для CLI: `AnswerService` и поиск активного пользователя по email |
| `create-bot.ts` | Telegram-бот: jobs, searches, answers, schedules, applications, сборщик и оценщик на каждый запуск, lock браузера, владелец бота |
| `create-user-administration.ts` | сервис пользователей для `user:create` |

Остальное в `framework`: `core` (Actor, ошибки, роли, часы), `http` (схема ошибки), `generator`
([generator.md](generator.md)).

### server/scripts — команды

| Файл | Команда | Что делает |
| --- | --- | --- |
| `collect.ts` | `npm run collect` | сбор вакансий |
| `score.ts` | `npm run score` | оценка и отправка в JT |
| `cycle.ts` | `npm run cycle` | сбор → оценка → JT одной командой |
| `pipeline-cli.ts` | — | общий разбор флагов и печать отчётов для `collect`, `score`, `cycle` и бота |
| `pipeline-tasks.ts` | — | общие прогоны `collectJobs`, `scoreOwners`, `runCycle` для CLI и бота |
| `bot.ts` | `npm run bot` | Telegram-бот: long polling, расписание, задачи |
| `bot-commands.ts` | — | разбор команд и кнопок бота, тексты ответов |
| `bot-runtime.ts` | — | `TaskRunner` (одна задача за раз), `Scheduler` (таймер расписания), `TelegramBot` (команды) |
| `answers.ts` | `npm run answers` | банк ответов: `list`, `set`, `delete` |
| `apply.ts` | `npm run apply` | подача: заполнить (`--limit`, `--job`), `--list`, `--submit`, `--reject`, `--answer` |
| `apply-cli.ts` | — | разбор аргументов и печать для `apply` |
| `answers-cli.ts` | — | разбор аргументов и печать для `answers` |
| `agent-guard.ts` | — | хук PreToolUse агента подачи (вызывает `claude`, не человек) |
| `browser-check.ts` | `npm run browser:check` | проверка брокера и входа в LinkedIn |
| `create-user.ts` | `npm run user:create` | создать пользователя (из `dist`, нужен build) |
| `check-architecture.ts` | `npm run architecture` | проверка границ доменов |
| `generate-domains.ts` | `npm run domain:generate` / `domain:check` | генерация DTO и схем из Prisma |

## 6. Связь с Job-Tracker

JT — отдельное приложение (свой репозиторий, Postgres). Контракт AI API описан в `docs/AI_API.md`
репозитория Job-Tracker. Используемые эндпоинты ([plugins/job-tracker.ts](../server/plugins/job-tracker.ts)):

| Запрос | Scope | Зачем |
| --- | --- | --- |
| `GET /api/ai/whoami` | — | чей токен: email пользователя JT |
| `GET /api/ai/profile-context` (+ `?format=markdown`) | `ai:profile:read` | ревизия и ETag профиля, затем markdown для промпта |
| `POST /api/ai/jobs/batch` | `ai:jobs:write` | до 50 вакансий в To Apply |
| `GET /api/ai/jobs?evaluation=none&limit=100` | `ai:jobs:read` | записи без оценки — для досылки |
| `PATCH /api/ai/jobs/:id/evaluation` | `ai:jobs:evaluate` | добавить оценку |

- **Токен:** создаётся в JT командой `npm run cli -- auth tokens create` со scopes
  `ai:profile:read,ai:jobs:read,ai:jobs:write,ai:jobs:evaluate`, кладётся в `JOB_TRACKER_TOKEN`,
  передаётся заголовком `Authorization: Bearer …` и не попадает в тексты ошибок.
- **Привязка пользователя.** Один токен — один пользователь JT. Работать с JT может только пользователь
  autopilot с тем же email (сравнение без учёта регистра). Остальным — 404 `TRACKER_NOT_LINKED`,
  в `npm run score` они «пропущены».
- **Что уходит в JT:** только `queued`-вакансии (название, компания, URL, описание до 100 000 символов,
  локация, источник, `externalId`, дата публикации) и оценка (`score`, `verdict`, `summary` = `why`,
  `redFlags`, `profileRevision`, `evaluatorName: job-autopilot`, `model`).
- **Что не уходит:** отсеянные и пропущенные вакансии, `raw`, `matchedSkills`/`missingSkills`,
  пользователи и сессии autopilot.

## 7. Настройка

Все переменные — в `.env` в корне (`npm run setup` создаёт его из [.env.example](../.env.example)).

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/job-autopilot.db` | SQLite; относительный путь — от `server/` |
| `PORT`, `HOST` | `3400`, `127.0.0.1` | адрес API |
| `JWT_SECRET` | случайный от `npm run setup` | подпись сессий |
| `JWT_TTL_SECONDS` | `3600` | срок сессии |
| `APP_ORIGIN`, `AUTH_ALLOWED_ORIGINS` | `http://localhost:3400`, `http://localhost:5173` | разрешённые origins |
| `COOKIE_SECURE` | `false` | `true` для HTTPS |
| `APP_PORT`, `COMPOSE_PROJECT_NAME` | `3400`, `job-autopilot` | Docker Compose |
| `AGENT_BROWSER_SOCKET` | `/run/agent-browser/broker.sock` | сокет брокера agent Chromium |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | сервер Ollama |
| `OLLAMA_MODEL` | `qwen3.5:4b` | модель по умолчанию; `--model` меняет на прогон |
| `OLLAMA_NUM_CTX` | `8192` | контекст на запрос (вывод ограничен 1024 токенами внутри кода) |
| `OLLAMA_TIMEOUT_MS` | `120000` | таймаут одного запроса к модели |
| `JOB_TRACKER_URL`, `JOB_TRACKER_TOKEN` | пусто | JT; пока хотя бы одно пусто, интеграция выключена, а `npm run score` не запускается |
| `APPLY_TIMEOUT_MS` | `600000` | предел одного запуска агента подачи |
| `DEEPSEEK_SETTINGS` | `~/.config/deepseek/claude-settings.json` | настройки `claude` для DeepSeek (ключ внутри; не выводить) |
| `PLAYWRIGHT_MCP_URL` | `http://127.0.0.1:8931/mcp` | Playwright MCP агента |
| `AGENT_CWD` | `/srv/agent-files/agent-run` | cwd `claude` агента и `files/` с копиями для загрузки (вне `/home`: MCP видит только `/srv/agent-files`) |
| `DEEPSEEK_PRICE_INPUT`, `_CACHE_READ`, `_OUTPUT` | пусто | цены DeepSeek, USD за 1M токенов; без них агент не создаётся |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | пусто | бот job-autopilot ([telegram.md](telegram.md)); без них `npm run bot` не стартует; бот отвечает только этому чату |
| `BOT_USER` | пусто | email владельца, от имени которого работает бот; пусто — единственный активный пользователь |
| `SCHEDULE_TIMEZONE` | `Europe/Dublin` | часовой пояс новых расписаний |
| `BOT_SCHEDULED_REPORT` | `changes` | отчёт после планового запуска: `changes` — при новых queued или ошибках, `always` — всегда |

**Ollama и модели.** Ollama работает системным сервисом (`systemctl status ollama`) на `OLLAMA_URL`,
модель должна быть скачана: `ollama pull qwen3.5:4b`.
Настройки сервера Ollama не меняются: `num_ctx`, `num_predict` и температура передаются в каждом запросе.
Сравнить модели можно флагом `--model` с `--dry-run`, ничего не записывая.

## 8. Дорожная карта

| Этап | Состояние |
| --- | --- |
| 1. Сбор (LinkedIn) | ✅ работает; нет удобного заведения поисков из терминала и второго источника |
| 2. Отбор (qwen по профилю JT) + передача в JT | ✅ код и тесты готовы, `npm run cycle` объединяет этапы 1–2; проверено на 17 живых вакансиях (выбрана `qwen3.5:4b`, порог 50); ⏳ проверка на ~50 |
| 3. Подача по одной вакансии | ✅ код и тесты на фейках: `npm run apply`, DeepSeek + Playwright MCP, «стоп перед Submit», отправка после ✅, отметка в JT; ⏳ живая проверка на 5 вакансиях |
| 4. Telegram и банк ответов | ✅ код и тесты: бот `npm run bot` (запуск, `/stop`, статус, поиски, queued, банк ответов, `/run apply`, ✅/❌, вопросы агента реплаем); ⏳ живая проверка |
| 5. Расписание и автоподача | ✅ расписание `collect`/`score`/`cycle`/`apply` в боте (cron, вкл/выкл), лимиты подачи; 📝 автоподача без ✅ |
| 6. Веб-интерфейс | 📝 по желанию; страница «Вакансии» пока пустая |

Чек-листы — в [guide.md](guide.md#6-дорожная-карта).

Открытые вопросы:

- **Связка пользователей JT ↔ autopilot.** Сейчас один токен в `.env` и совпадение email — это
  один пользователь. Для нескольких пользователей нужен токен на пользователя.
- **systemd.** Таймер для `npm run cycle`, окно запуска и блокировка общей вкладки браузера от
  Telegram-бота на время прогона.
- Нужен ли второй источник сбора кроме LinkedIn.

## 9. Глоссарий

| Термин | Значение |
| --- | --- |
| **agent Chromium** | общий Chromium на сервере с постоянным профилем, где выполнен вход в LinkedIn |
| **брокер** | процесс local-agent за Unix-сокетом, дающий доступ к agent Chromium только на чтение |
| **источник (source)** | модуль сайта (`linkedin`, `manual` для ручного добавления) |
| **сохранённый поиск** | запись `searches`: источник, запрос, локация, слова фильтра |
| **прогон** | один проход поиска; отчёт — `search_runs` |
| **фильтр по названию** | `--include` / `--exclude`; отсев до открытия страницы вакансии |
| **found** | вакансия собрана с описанием и ждёт оценки |
| **scored** | модель поставила оценку; сразу за ним идёт решение |
| **queued** | отобрана для подачи (≥ порога или вручную); такие уходят в JT |
| **rejected** | отсеяна фильтром или моделью; причина в `why` |
| **skipped** | повтор: двойник у нас или запись уже есть в JT / подача уже была |
| **score** | целое 0–100 от модели |
| **порог** | `SCORE_THRESHOLD = 50`; `--threshold` меняет его на прогон |
| **verdict** | словарь JT поверх score: `STRONG_FIT`, `GOOD_FIT`, `WEAK_FIT`, `NOT_A_FIT` |
| **why / redFlags** | короткая причина оценки и список проблем по-русски |
| **профиль** | markdown кандидата из JT (`profile-context`), по нему оценивает модель |
| **profileRevision** | ревизия профиля JT, по которой поставлена оценка |
| **ETag** | метка версии профиля; при совпадении JT отвечает 304 без тела |
| **двойник (twin)** | другая вакансия с той же компанией и названием, уже оценённая или отправленная в JT |
| **trackerId** | ID записи To Apply в JT; пустой — ещё не отправлена |
| **To Apply** | список вакансий к подаче в JT (JobOpportunity) |
| **досылка оценок (backfill)** | отправка оценок для записей JT, созданных без оценки из-за сбоя |
| **привязка** | пользователь autopilot с тем же email, что владелец токена JT |
| **JobPipelineApi** | интерфейс домена jobs для этапов конвейера |
| **applier** | 📝 будущий этап подачи |
