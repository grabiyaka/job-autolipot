# Домен `jobs`

Вакансии пользователя: ручное добавление, выдача с фильтрами, решения по вакансиям и API
для этапов конвейера (сбор, отбор, подача). Код лежит в [server/src/jobs](../server/src/jobs).

Каждая вакансия принадлежит пользователю (`jobs.userId`). Все методы репозитория
ограничены владельцем, поэтому чужая вакансия ведёт себя как несуществующая и даёт 404.

## Файлы

| Файл | Что внутри |
| --- | --- |
| `JobRoutes.ts` | Маршруты и JSON-схемы. |
| `JobController.ts` | HTTP-ввод → вызов сервиса → ответ. |
| `JobService.ts` | Типы (`Job`, `JobInput`, …), статусы и переходы, проверка URL, все сценарии. |
| `JobRepository.ts` | Prisma-запросы, всегда с фильтром по владельцу. |

## Статусы

Основной путь: `found → scored → queued → applying → applied`.

Все переходы заданы в `JobService.ts`:

| Из | Можно перейти в |
| --- | --- |
| `found` | `scored`, `queued`, `rejected`, `skipped` |
| `scored` | `scored` (переоценка), `queued`, `rejected`, `skipped` |
| `rejected` | `scored`, `queued`, `skipped` |
| `queued` | `applying`, `rejected`, `skipped` |
| `applying` | `applied`, `needs_input`, `failed` |
| `needs_input` | `queued`, `applying`, `skipped` |
| `failed` | `queued`, `skipped` |
| `skipped` | `queued` |
| `applied` | — (финальный) |

Человек вручную ставит только `queued`, `rejected` или `skipped`. Остальные статусы
выставляют scorer и applier через API конвейера. Изменение статуса условное:
если другой процесс успел поменять статус раньше, запрос получит 409 `JOB_STATUS_CHANGED`.

## HTTP API

Все маршруты требуют входа (`authenticatedAccess`) и работают только со своими вакансиями.

| Запрос | Результат |
| --- | --- |
| `GET /api/jobs` | `{ items, total, page, limit }` без описаний. Параметры: `page`, `limit` (1–100, по умолчанию 20), `status`, `source`, `search` (по названию и компании), `sort=found\|score`. |
| `GET /api/jobs/summary` | `{ total, counts }`: количество по каждому статусу, включая нули. |
| `GET /api/jobs/:id` | Вакансия с `description`. |
| `POST /api/jobs` | Добавить вручную: `{ url, title, company, source?, location?, description? }`. Ответ 201; повтор URL даёт 409 `JOB_EXISTS`. `source` по умолчанию `manual`. |
| `PATCH /api/jobs/:id` | `{ status: 'queued' \| 'rejected' \| 'skipped' }`. Неразрешённый переход даёт 409. |
| `DELETE /api/jobs/:id` | 204. |

`sort=found` показывает новые первыми. `sort=score` упорядочивает по оценке, вакансии
без оценки идут в конце. Поиск в SQLite не учитывает регистр только для латиницы:
`vue` найдёт `Vue`, а `разработчик` не найдёт `Разработчик`.

Поле `raw` (сырые данные карточки от модуля) хранится в БД, но по HTTP не отдаётся.
`redFlags` в ответе — массив строк, в БД — JSON-строка.

## API конвейера

Эти методы `JobService` не выставлены в HTTP. Их вызывают сборщик, scorer и applier
от имени владельца (`ownerId`):

| Метод | Назначение |
| --- | --- |
| `recordFound(ownerId, listings)` | Записать найденные карточки. Ответ `{ created, duplicates, invalid, jobIds }`. Некорректная карточка пропускается и попадает в `invalid`, пачка при этом не падает. Дубли отсекаются внутри пачки и по БД: по `(userId, url)` и `(userId, source, externalId)`. |
| `unknownUrls(ownerId, urls)` | Какие из URL пользователь ещё не видел. Сборщик вызывает это до загрузки описаний. Некорректные URL отбрасываются. |
| `recordScore(ownerId, id, { score, why?, redFlags? })` | Оценка 0–100 от scorer, статус становится `scored`. |
| `recordStatus(ownerId, id, status)` | Переход статуса от applier (`applying`, `applied`, `needs_input`, `failed`) по таблице выше. |

Модуль источника сам убирает свои трекинг-параметры (`utm_*`, `refId` и т. п.) до передачи
карточки. Домен только приводит URL к общей форме: срезает `#фрагмент` и проверяет схему.

## Проверки

- [tests/jobs.test.ts](../server/tests/jobs.test.ts) — URL, нормализация карточек, переходы статусов, оценка.
- [tests/jobs-integration.test.ts](../server/tests/jobs-integration.test.ts) — HTTP и API конвейера
  на временной SQLite: изоляция владельцев, дедуп, фильтры, сортировка, страницы, переходы, удаление.
