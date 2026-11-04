# Домен `trackers` (Job-Tracker)

[Job-Tracker](https://job-tracker.elijah.kiev.ua) (JT) — отдельное приложение: в нём хранятся профиль
кандидата и список To Apply. Autopilot берёт оттуда профиль для оценки вакансий и отправляет туда
отобранные (`queued`) вакансии вместе с оценкой. Обмен идёт через AI API JT (`/api/ai/*`, контракт описан в
`docs/AI_API.md` репозитория Job-Tracker). Код лежит в [server/src/trackers](../server/src/trackers), HTTP-клиент — в
[server/plugins/job-tracker.ts](../server/plugins/job-tracker.ts).
Место этого домена во всём конвейере — в [overview.md](overview.md#43-передача-в-job-tracker-).

## Настройка

`JOB_TRACKER_URL` и `JOB_TRACKER_TOKEN` в `.env`. Токен создаётся в JT командой
`npm run cli -- auth tokens create` со scopes `ai:profile:read,ai:jobs:read,ai:jobs:write,ai:jobs:evaluate`.
Пока хотя бы одна переменная не задана, приложение работает, а домен отвечает 503 `TRACKER_NOT_CONFIGURED`.

Токен принадлежит одному пользователю JT. Работать с JT может только пользователь autopilot с тем же email
(`GET /api/ai/whoami`, регистр не учитывается). Для остальных пользователей интеграция не существует:
404 `TRACKER_NOT_LINKED`.

## Файлы

| Файл | Что внутри |
| --- | --- |
| `TrackerTypes.ts` | Контракт клиента JT (`JobTrackerClient`, `TrackerError`) и публичный `TrackerApi` для scoring. |
| `TrackerRoutes.ts` | Маршруты и JSON-схемы. |
| `TrackerController.ts` | HTTP-ввод → вызов сервиса. |
| `TrackerService.ts` | Привязка по email, кеш профиля, отправка вакансий, словарь вердиктов JT. |
| `TrackerRepository.ts` | Таблица `tracker_profiles`: копия профиля, одна строка на пользователя. |

## Профиль

`TrackerApi.profile(ownerId)` сверяет сохранённую копию с JT по ETag. Если профиль не менялся (304),
обновляется только `fetchedAt`. Если изменился, сохраняются новые markdown, ревизия и ETag.
Когда JT недоступен (сеть, таймаут, 5xx, 429), возвращается сохранённая копия с `fromCache: true`.
Если копии нет, возвращается ошибка 503 `TRACKER_UNAVAILABLE`. Отказ по токену (401/403) даёт
502 `TRACKER_UNAUTHORIZED`, копия в этом случае не используется.

## Отправка вакансий

`TrackerApi.pushQueued(ownerId, { model? })` сначала досылает недостающие оценки, затем отправляет
одну пачку: до 50 вакансий `queued`, которые ещё не отправлены (`trackerId` пуст). Лимит JT — 60 запросов в минуту, и каждая
созданная вакансия требует ещё один запрос на оценку. Поэтому остаток (`remaining`) уходит при следующем прогоне.

| Ответ JT | Что происходит здесь |
| --- | --- |
| `created` | Оценка отправляется в JT (`PATCH …/evaluation`), затем вакансия получает `trackerId`. |
| `duplicate_opportunity` | Статус `skipped`, причина «уже в Job-Tracker». |
| `already_applied` | Статус `skipped`, причина «уже подавался». |
| `invalid` | Вакансия остаётся `queued`, ошибки попадают в отчёт. |

Оценка: `score`; `verdict` по score (≥ 80 `STRONG_FIT`, 70–79 `GOOD_FIT`, 50–69 `WEAK_FIT`,
< 50 `NOT_A_FIT`; порог отбора тоже 50, поэтому `queued` с оценкой 50–69 приходят в JT как `WEAK_FIT`); `summary` = `why`; `redFlags`; `profileRevision` вакансии; `evaluatorName` `job-autopilot`;
`model` из параметров. Вакансия без оценки или без `profileRevision` отправляется без оценки.

Если JT отказал до создания пачки, ошибка попадает в `error` отчёта, а вакансии остаются неотправленными.
Если JT перестал принимать оценки посреди пачки, уже созданные вакансии всё равно получают `trackerId`:
при повторной отправке JT ответил бы `duplicate_opportunity`. Такие вакансии перечислены в `unevaluated`.

Источником правды о недостающих оценках служит JT. В начале каждого прогона читается его список
`GET /api/ai/jobs?evaluation=none` (по страницам через `nextCursor`). Для каждой записи ищется своя вакансия
по `trackerId` (`JobPipelineApi.findByTrackerId`). Если у неё есть score и `profileRevision`, оценка
отправляется. Записи, добавленные в JT не отсюда, и вакансии без оценки пропускаются. За прогон досылается
не больше 50 оценок; число досланных — `backfilled` в отчёте.

## HTTP API

Маршруты требуют входа (`authenticatedAccess`) и работают только для привязанного пользователя.

| Запрос | Результат |
| --- | --- |
| `GET /api/tracker/status` | `{ configured, linked, profile: { revision, fetchedAt } \| null, error }`. `linked: null` и текст в `error` — JT не ответил. |
| `GET /api/tracker/profile` | `{ markdown, revision, fetchedAt, fromCache }`. Без параметров отдаёт сохранённую копию, а если её нет, загружает профиль. С `?refresh=true` сверяет копию с JT. |
| `POST /api/tracker/push` | Отправить очередную пачку сейчас. Ответ — отчёт `{ created, backfilled, duplicates, alreadyApplied, invalid, unevaluated, remaining, error }`. |

## Проверки

- [tests/job-tracker.test.ts](../server/tests/job-tracker.test.ts) — плагин на фейковом HTTP-сервере: профиль 200/304,
  исходы batch, страница списка с курсором, 401/403/429/4xx/5xx, таймаут, отказ соединения, токен не попадает в ошибки.
- [tests/trackers-integration.test.ts](../server/tests/trackers-integration.test.ts) — сервис и HTTP на временной SQLite
  с фейковым JT: привязка по email, кеш и fallback профиля, все исходы отправки, повторный прогон, досылка оценок после 429 посреди пачки, пачки по 50,
  поиск по `trackerId` только у владельца.
