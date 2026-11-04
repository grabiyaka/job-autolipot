# Документация job-autopilot: с чего начать

Здесь собрана вся документация проекта: что в каком файле лежит, в каком порядке читать
и какая команда за что отвечает. Если читаешь впервые, иди по разделу «Порядок чтения» сверху вниз.

## Порядок чтения

| № | Файл | Зачем читать | Когда |
|---|---|---|---|
| 1 | [../README.md](../README.md) | идея проекта, весь конвейер на одной схеме, защиты, порядок сборки | первым, 10 минут |
| 2 | [overview.md](overview.md) | **главный документ**: путь вакансии от LinkedIn до Job-Tracker, все этапы подробно, карта кода (какой файл за что отвечает), глоссарий | чтобы понять, как всё устроено |
| 3 | [guide.md](guide.md) | **практика**: первый запуск, первый полный цикл по шагам, ежедневный сбор, флаги, где смотреть результат, таблица ошибок, дорожная карта с чек-листами | когда хочешь запустить и потыкать |
| 4 | [development.md](development.md) | запуск для разработки, Docker, `.env`, миграции, проверки | когда меняешь код |

Дальше документы по отдельным частям. Их стоит открывать, только когда лезешь в эту часть.

## Документы по частям системы

### Конвейер (бизнес-логика)

| Файл | Что внутри |
|---|---|
| [collector-plan.md](collector-plan.md) | этап 1 «Сбор»: как устроен сборщик, интерфейс модуля источника, что берёт на себя ядро (дедуп, лимиты, паузы), детали LinkedIn |
| [jobs.md](jobs.md) | домен `jobs`: статусы вакансии и переходы, HTTP API `/api/jobs`, API для этапов конвейера |
| [trackers.md](trackers.md) | интеграция с Job-Tracker: настройка токена, откуда берётся профиль для оценки, отправка `queued` вакансий в To Apply |

Этап 2 «Отбор» (оценка через Ollama) описан в [overview.md, раздел 4.2](overview.md#42-отбор-), отдельного файла нет.

### Каркас и код

| Файл | Что внутри |
|---|---|
| [architecture.md](architecture.md) | структура сервера, нейминг файлов (`*Routes`, `*Service`, `*Repository`…), DI, границы между доменами, плагины |
| [authentication.md](authentication.md) | регистрация, вход, JWT в cookie, сессии, роли, создание администратора |
| [frontend.md](frontend.md) | клиент на Vue 3 Options API: структура, состояние, SCSS, адаптивность |
| [generator.md](generator.md) | генератор CRUD-доменов из Prisma (для вакансий не используется, только для простых справочников) |

Служебный файл: [../AGENTS.md](../AGENTS.md) — правила для ИИ-агентов, которые пишут код. Человеку его читать не обязательно.

## Команды

Все команды запускаются из корня `~/projects/job-autopilot`. Корневые `npm run …` вызывают одноимённые
скрипты из `server/` или `client/`. Скрипты конвейера лежат в `server/scripts/`.
Флаги любой из них можно посмотреть так: `npm run <команда> -- --help`.

### Конвейер вакансий

| Команда | Файл | Что делает | Подробнее |
|---|---|---|---|
| `npm run collect -- …` | `server/scripts/collect.ts` | **сбор**: читает выдачу LinkedIn через agent Chromium, фильтрует по названию, сохраняет как `found` или `rejected`. С `--dry-run` только печатает | [guide.md §4](guide.md#4-ежедневное-использование) |
| `npm run score -- …` | `server/scripts/score.ts` | **отбор**: локальная модель (Ollama) оценивает `found` вакансии по профилю из Job-Tracker: `queued` или `rejected`, затем отправляет `queued` в JT | [overview.md §4.2](overview.md#42-отбор-) |
| `npm run cycle -- …` | `server/scripts/cycle.ts` | **один полный прогон**: сбор → оценка → отправка в JT. Сюда же потом подключится расписание | `npm run cycle -- --help` |
| `npm run browser:check` | `server/scripts/browser-check.ts` | проверка брокера agent Chromium; с `--open <URL>` показывает страницу (так проверяют вход в LinkedIn) | [guide.md §3](guide.md#3-первый-запуск-один-раз) |

### Установка и запуск приложения

| Команда | Что делает |
|---|---|
| `npm run setup` | создаёт `.env` из `.env.example` со случайным `JWT_SECRET`. Существующий `.env` не трогает |
| `npm run install:all` | ставит зависимости `server` и `client` |
| `npm run db:generate` | генерирует Prisma Client и домены |
| `npm run db:migrate` | создаёт или обновляет базу `server/data/job-autopilot.db`. Повторяй после `git pull` с новыми миграциями |
| `npm run user:create -- --email … --name …` | создаёт пользователя, пароль спрашивает в терминале. Нужен `npm --prefix server run build` |
| `npm run dev` | API на `:3400` (Swagger: `/docs`) и клиент на `:5173` с автообновлением |
| `npm run dev:server` / `dev:client` | то же, но только одна часть |
| `npm run build` / `npm start` | production-сборка и запуск собранного сервера |

### Проверки и генерация

| Команда | Что делает |
|---|---|
| `npm run check` | все проверки: `check:server` + `check:client` |
| `npm run check:server` | генерация, TypeScript, архитектурные границы, тесты, сборка сервера |
| `npm run check:client` | типы Vue, соглашения кода и стилей, тесты, сборка клиента |
| `npm test` | только тесты обеих частей |
| `npm run architecture` | проверка границ между доменами (`server/scripts/check-architecture.ts`) |
| `npm run domain:generate` / `domain:check` | генерация DTO и схем из Prisma / проверка, что сгенерированное не устарело |

### Docker

`docker compose up --build -d --wait` поднимает только веб-приложение (API + клиент на `:3400`).
Команд конвейера (`collect`, `score`, `cycle`) в образе нет, и доступа к браузеру у контейнера тоже нет.
Они запускаются на хосте. Подробнее в [development.md](development.md#docker).

## Где что лежит в коде

| Путь | Что там |
|---|---|
| `server/src/<домен>/` | бизнес-логика по доменам: `users`, `jobs`, `searches` (сбор), `scoring` (отбор), `trackers` (Job-Tracker) |
| `server/plugins/` | техника: браузерный брокер, Ollama, HTTP-клиент Job-Tracker, окружение |
| `server/framework/composition/` | сборка зависимостей для приложения и для каждой CLI-команды |
| `server/scripts/` | CLI-команды из таблицы выше |
| `server/prisma/schema.prisma` | модель данных (таблицы) |
| `server/data/job-autopilot.db` | сама база SQLite |
| `client/` | веб-интерфейс на Vue |

Подробная карта по файлам: [overview.md §5](overview.md#5-карта-кода).
