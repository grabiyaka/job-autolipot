# Сборщик вакансий (этап 1 «Сбор»)

Статус: **ядро и первый модуль (LinkedIn) работают.** Готовы контракт модуля, прогон с паузами,
лимитами и изоляцией ошибок, HTTP-клиент, браузер (брокер agent Chromium), CLI `npm run collect`
и тесты. В БД сборщик пишет через [домен `jobs`](jobs.md): `JobPipelineApi.unknownUrls` и `recordFound`.

## Цель

Один скрипт `npm run collect` выполняет поиски каждого пользователя на включённых источниках
(remote-доски, LinkedIn, …), складывает вакансии в его выдачу в `jobs` со статусом `found`
и не создаёт дублей. Новый сайт добавляется отдельным модулем, ядро при этом не меняется.

## Что уже есть

Сборщик — домен [`searches`](../server/src/searches): сохранённые поиски пользователя и прогоны по ним.

```
server/
  src/searches/
    SearchRoutes.ts         HTTP: источники, CRUD своих поисков, история прогонов
    SearchController.ts
    SearchService.ts        CRUD поисков; runSaved() и runAdHoc(): обход страниц, паузы, лимиты,
                            details() для новых, изоляция ошибок, отчёт прогона
    SearchRepository.ts     таблицы searches и search_runs
    SearchRules.ts          чистые помощники: проверка полей поиска, каноничные карточки, пауза
    SearchTypes.ts          публичный контракт модуля сайта: JobSource, JobCard, SearchQuery, SourceContext
    SearchSources.ts        явный реестр модулей, по одной строке на источник
    LinkedinSource.ts       модуль LinkedIn: выдача, прокрутка, страница вакансии
    LinkedinParser.ts       чистый разбор LinkedIn: URL, ссылки, заголовок, шапка, описание
  src/jobs/JobTypes.ts      JobPipelineApi: unknownUrls и recordFound — всё, что сборщик видит в jobs
  plugins/http.ts           fetch-клиент: таймаут, User-Agent, ретраи на сетевые ошибки, 429 и 5xx
  plugins/browser-broker.ts клиент брокера agent Chromium (только чтение): open, text, links, scroll
  scripts/browser-check.ts  ручная проверка браузера: npm run browser:check -- [--open URL]
  scripts/collect.ts        CLI: npm run collect
  framework/composition/
    create-searches.ts      сборка SearchService (общая для HTTP и CLI)
    create-collector.ts     сборка для CLI: Prisma → JobService → SearchService, поиск пользователя по email
  tests/searches.test.ts    прогон на фейковом источнике, сохранённые поиски на SQLite, HTTP API, HTTP-клиент
```

CLI (`npm run collect -- --help` печатает справку):

```bash
npm run collect -- --user me@x.com --source linkedin --query "node.js" [--location Remote] \
  [--include "node,typescript"] [--exclude "java,android,qa"] [--dry-run] [--max-minutes 60]
# разовый поиск: вакансии пишутся в jobs, сам поиск и отчёт прогона не сохраняются

npm run collect -- [--user me@x.com] [--dry-run] [--max-minutes 60]
# включённые сохранённые поиски всех активных пользователей (или одного); отчёт каждого — в search_runs
```

### Фильтр по названию

Сборщик не оценивает вакансии, это делает этап «Отбор». Единственный фильтр — по названию,
и он нужен ради скорости: отсеянная вакансия отбрасывается **до** открытия её страницы
(на LinkedIn это ~8 с на вакансию).

- `includeTitle` (`--include`) — в названии должно быть хотя бы одно из слов; пусто — любое название.
- `excludeTitle` (`--exclude`) — любое из слов отсеивает вакансию; исключение сильнее включения.
- Слова и фразы ищутся целиком, без учёта регистра: `java` не задевает `JavaScript`,
  `node` находит `Node.js`, `c++` и `.net` пишутся как есть. До 50 слов по 60 символов.
- Отсеянная вакансия **сохраняется** в `jobs` со статусом `rejected` и причиной в `why`
  («название: исключено «java»»), без описания и, для LinkedIn, без компании. Так следующий прогон
  знает её и может остановиться на `known`, а человек может вернуть её в очередь (`PATCH /api/jobs/:id`).
- В `--dry-run` принятые печатаются с `+`, отсеянные с `−` и причиной. В отчёте и `search_runs`
  отсеянные считаются в `filtered`.

Поиски заводятся через `POST /api/searches` (Swagger: `/docs`). Сохранить поиск можно только
на подключённый источник. Если модуль позже убрали из реестра, его поиск попадает в отчёт
с ошибкой, остальные выполняются. Пробные прогоны (`--dry-run`) в историю не пишутся.

### Браузер

Модуль получает `context.browser` (интерфейс `Browser` из `SearchTypes.ts`). Реализация —
клиент брокера local-agent: Unix-сокет `AGENT_BROWSER_SOCKET` (по умолчанию
`/run/agent-browser/broker.sock`), видимый Chromium на сервере с постоянным профилем, в котором
пользователь уже вошёл на сайты (вход вручную через noVNC). Брокер только читает страницы:
кликать, вводить и отправлять он не умеет. Открыть можно только URL из его allow-list
(сейчас `https://www.linkedin.com/`), и `links()` возвращает только такие ссылки.

- Вкладка одна и общая с Telegram-ботом и local-agent. Если страница сменилась между вызовами,
  `text()` и `links()` падают с `BrowserError`, а не смешивают две страницы. Отдельной
  блокировки вкладки пока нет.
- `BrowserUnavailableError` (нет сокета, отказ соединения, таймаут 120 с) останавливает весь
  прогон: остальные поиски не выполняются. `BrowserBlockedError` — отказ allow-list.
- Проверено вживую 2026-11-03: `npm run browser:check -- --open https://www.linkedin.com/jobs/`
  открывает страницу вакансий от имени вошедшего пользователя. Поиск
  `/jobs/search/?keywords=node.js&f_WT=2&sortBy=DD` без прокрутки отдаёт 7 ссылок `/jobs/view/<id>/`.

Границы проверяет `npm run architecture` по общим правилам доменов: `searches` видит `jobs`
только через `JobTypes.ts`, Prisma есть только в `SearchRepository`, Fastify — в Routes/Controller.

## Контракт модуля

```ts
export interface JobSource {
  readonly id: string;                // 'remoteok' → jobs.source
  readonly title: string;
  readonly limits: { pageDelayMs: [min: number, max: number]; maxPagesPerQuery: number };

  /** Страницы выдачи по одной; ядро перестаёт читать, когда на странице нет нового. */
  search(context: SourceContext, query: SearchQuery): AsyncIterable<JobCard[]>;
  /** Данные страницы вакансии (описание, компания, локация, …). Вызывается только для новых. */
  details?(context: SourceContext, card: JobCard): Promise<JobDetails>;
  /** URL без трекинга (utm, refId, …): ключ дедупликации. Должен быть идемпотентным. */
  canonicalUrl(url: string): string;
}

export type SearchQuery = { keywords: string; location?: string };
export type JobCard = {
  url: string; title: string; company: string; externalId?: string;
  location?: string; postedAt?: Date; description?: string; raw?: unknown;
};
export type JobDetails = { description?: string; title?: string; company?: string; location?: string; raw?: unknown };
export type SourceContext = {
  http: HttpClient; browser: Browser; log: Logger; signal: AbortSignal;
  pause(ms: number): Promise<void>;   // пауза внутри страницы выдачи, прерывается вместе с прогоном
};
// throw new SourceStopError(…): сайт не пускает (логин, капча) — поиск и остальные поиски этого источника в прогоне останавливаются
```

`JobCard` по полям совпадает с `JobInput` из `server/src/jobs/JobTypes.ts`. Ядро заменяет URL
на каноничный, добавляет `source` модуля и передаёт карточки в `recordFound`.
Запросы через `context.http` автоматически прерываются вместе с прогоном.

Модуль подключается явной строкой в `SearchSources.ts`. Динамической загрузки папок нет:
так сохраняются автокомплит и проверка типов, и это соответствует правилам проекта
(«без динамического DI»).

Фильтрация при сборе ограничена тем, что понимает сам сайт: ключевые слова, локация, remote.
Стоп-слова, зарплата и соответствие CV оцениваются позже, на этапе отбора.

## Что делает ядро (модуль об этом не думает)

1. Нормализует URL карточек через `canonicalUrl`, отбрасывает некорректные и повторы внутри прогона.
2. Через `unknownUrls` выбирает вакансии, которых у пользователя ещё нет. Если на странице
   нет ни одной новой, листание останавливается (`known`): ежедневный прогон остаётся дешёвым.
   Новые с неподходящим названием сохраняются как `rejected` (см. «Фильтр по названию»).
3. Догружает `details()` только для новых карточек без описания и дополняет карточку
   заданными полями. Если страница не загрузилась, карточка сохраняется как есть (если в ней
   хватает полей), а `SourceStopError` и недоступный браузер останавливают поиск.
4. Пишет новые через `recordFound` от имени владельца. В `--dry-run` только печатает их.
5. Делает случайную паузу из `pageDelayMs` между страницами и останавливается на `maxPagesPerQuery` (`limit`).
6. Ошибка источника попадает в отчёт (`error`), уже сохранённые страницы остаются,
   следующие поиски продолжаются. Ctrl+C и `--max-minutes` останавливают прогон (`aborted`).
7. Печатает итог по каждому поиску: страницы, карточки, новые, записано, дубли, некорректные,
   причина остановки. При ошибке источника код выхода 1.

## Модули источников (план)

Домен остаётся плоским (правило `server/AGENTS.md`), поэтому модуль — пара файлов в `src/searches/`:

```
src/searches/
  RemoteokSource.ts          поиск и навигация (реализует JobSource)
  RemoteokParser.ts          чистый разбор JSON/HTML → JobCard (без I/O)
tests/fixtures/remoteok/     сохранённые ответы для тестов парсера
docs/sources/remoteok.md     URL поиска, лимиты, признаки блокировки, дата проверки
```

| Транспорт | Когда | Примеры | Цена поддержки |
|-----------|-------|---------|----------------|
| API | у сайта есть JSON/RSS/публичный API | RemoteOK, WeWorkRemotely (RSS), Greenhouse и Lever board API | низкая |
| HTML | серверный HTML без JS | многие небольшие доски | средняя |
| Браузер | JS-рендер, вход, антибот | LinkedIn | высокая: селекторы ломаются |

Правило: модуль берёт самый дешёвый транспорт, который работает. Сначала API, потом HTML,
в последнюю очередь браузер.

LinkedIn читается через `context.browser` (раздел «Браузер» выше): вход уже выполнен
в профиле agent Chromium. Выдача подгружается при прокрутке, поэтому модулю нужен `scroll()`. Для этапа «Подача»
в `docs/sources/` потом появится `<id>-apply.md`: подсказки агенту по формам этого сайта.

## Проверки

- Есть: прогон на фейковом источнике (дедуп, остановка на известных, лимит страниц, details только
  для новых, dry-run, неподключённый источник), сохранённые поиски на временной SQLite (порядок,
  выключенные пропускаются, отчёты в search_runs, изоляция ошибок, остановка по сигналу,
  удалённый модуль), связка с `JobService` (выдачи двух пользователей не смешиваются, повторный
  прогон не создаёт дублей), HTTP API (чужие поиски не видны, неизвестный источник — 400)
  и HTTP-клиент (ретраи 5xx, без ретраев 404, User-Agent).
- План: парсер каждого модуля — чистая функция, её тестируют на `fixtures/` без сети.
  Общий контрактный тест по реестру: id уникален, `canonicalUrl` идемпотентен и убирает трекинг.
- Живой прогон: `npm run collect -- --user … --source X --query … --dry-run` печатает карточки
  и ничего не пишет.

## LinkedIn

`LinkedinSource.ts` и `LinkedinParser.ts`, фикстуры с живого LinkedIn (2026-11-03) в
`server/tests/fixtures/linkedin/` (трекинговые id затёрты, подвал страницы отрезан).

- **Выдача:** `/jobs/search/?keywords=…&sortBy=DD`; локация «Remote» превращается в фильтр `f_WT=2`,
  другая передаётся как `location`. Следующая страница — тот же URL с `start=25, 50, …`.
  Карточки появляются через секунду-две после загрузки, поэтому пустое чтение повторяется
  (до 3 раз через 2 с). Затем до 3 прокруток: на живой выдаче они догружают ~14–17 из 25 карточек.
- **Карточка:** id из `/jobs/view/<id>/`, ключ — `https://www.linkedin.com/jobs/view/<id>/`,
  название из текста ссылки. Компании в ссылке нет, её добавляет `details()`.
- **Страница вакансии:** открывается через 4 с после предыдущей. Компания и название из заголовка
  `Title | Company | LinkedIn`, локация из строки шапки `Город · 18 minutes ago · …`, описание —
  раздел «About the job» до «Set alert for similar jobs» (или «About the company»).
  В `raw` хранится `easyApply` — признак отклика прямо на LinkedIn (пригодится этапу «Подача»).
- **Темп:** 6–12 с между страницами выдачи, не больше 4 страниц на поиск.
- **Стоп:** login, authwall, checkpoint или `/uas/` — `SourceStopError`, остальные поиски LinkedIn
  в этом прогоне пропускаются. Решение: войти в agent Chromium через noVNC.
- **Ограничения:** парсер рассчитан на английский интерфейс LinkedIn. Прокрутка не догружает
  все 25 карточек страницы, часть вакансий может попасть только в следующий прогон.

## Порядок работ

1. ~~Ядро прогона, CLI, фейковый источник и тесты.~~ Готово.
2. Первый модуль без входа: remote-доски (RemoteOK, затем WeWorkRemotely или Greenhouse/Lever).
3. ~~Домен `searches`: CRUD своих поисков, прогон поисков всех активных пользователей.~~ Готово.
   Осталось: одинаковые запросы разных пользователей загружать один раз; страница «Вакансии» поверх `jobs`.
4. ~~LinkedIn: через брокер agent Chromium, медленный темп, фикстуры.~~ Готово, см. ниже.
5. ~~История прогонов (`search_runs`).~~ Готово. Осталось: systemd timer.

## Открытые вопросы

- Вход на сайты с логином: у каждого пользователя свой профиль браузера, поэтому сборщик
  с такими источниками должен работать на машине, где пользователь один раз вошёл.
