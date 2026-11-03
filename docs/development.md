# Разработка: запуск, структура, проверки

Стек: **Vue 3 Options API**, **Fastify 5**, **Prisma 7**, **SQLite** и строгий **TypeScript**.
Каркас взят из jwx-framework. Явный DI сохраняет автокомплит, каждый домен держит свои маршруты,
бизнес-правила лежат отдельно от HTTP и хранения. Соглашения описаны в [architecture.md](architecture.md).

## Локальный запуск

Нужен Node.js 22.12 или новее. Отдельный сервер БД не нужен: SQLite — это файл
`server/data/job-autopilot.db`. Команды выполняются из корня:

```bash
npm run setup          # .env из .env.example со случайным JWT_SECRET; существующий не трогает
npm run install:all    # зависимости server и client по их lock-файлам
npm run db:generate    # Prisma Client и сгенерированные домены
npm run db:migrate     # создаёт или обновляет файл БД (prisma migrate deploy)
npm run dev            # API на :3400 и Vite на :5173 с автообновлением
```

Открой [localhost:5173](http://localhost:5173) и зарегистрируйся на странице `/register`.
Vite проксирует `/api` на backend, JWT лежит в HttpOnly cookie, в localStorage ничего не хранится.

Администратора создаёт CLI. Пароль он спрашивает в терминале:

```bash
npm --prefix server run build
npm run user:create -- --email admin@example.com --name Admin --role admin
```

## Docker

```bash
npm run setup
docker compose up --build -d --wait
docker compose exec api npm run user:create -- --email admin@example.com --name Admin --role admin
```

В контейнере Fastify отдаёт клиентскую сборку и API с одного адреса: [localhost:3400](http://localhost:3400).
При старте контейнер применяет миграции. Файл БД лежит в томе `job_autopilot_data`, поэтому
`docker compose down` данные сохраняет, а `down -v` удаляет их вместе с томом.

Полезные адреса: [Swagger](http://localhost:3400/docs) (использует cookie текущего входа)
и [health](http://localhost:3400/api/health) (API и соединение с БД).

## Настройки `.env`

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` | SQLite в форме `file:<путь>`; относительный путь считается от `server/`. По умолчанию `file:./data/job-autopilot.db`. |
| `JWT_SECRET` | Обязательный случайный секрет, минимум 32 байта. |
| `JWT_TTL_SECONDS` | Срок сессии, по умолчанию `3600`, допустимо от `60` до `86400`. |
| `APP_ORIGIN` | Публичный origin приложения, например `http://localhost:3400`. |
| `AUTH_ALLOWED_ORIGINS` | Дополнительные разрешённые origins через запятую, например Vite `http://localhost:5173`. |
| `COOKIE_SECURE` | `true` для HTTPS, `false` для локального HTTP. |
| `PORT`, `HOST` | Адрес API, по умолчанию `127.0.0.1:3400`. |
| `APP_PORT`, `COMPOSE_PROJECT_NAME` | Опубликованный порт и имя установки Docker Compose. |

Подробнее про вход и cookie — в [authentication.md](authentication.md).

## Структура

```text
client/
  src/components/      страницы по сущностям (jobs, user) и общие ui-компоненты
  src/store/           Pinia
  src/router/          Vue Router
  src/assets/css/      общие стили и SCSS-миксины
server/
  src/                 плоские домены; сейчас users
  framework/           core, composition, http и генератор
  plugins/             технические возможности: БД, пароли, клиент, системные маршруты
  middlewares/         идентификация и уровни HTTP-доступа
  prisma/              схема, миграции, domains.json для генератора
  data/                файл SQLite, вне Git
  generated/           Prisma Client, вне Git
docs/                  документация
Dockerfile             общая сборка клиента и сервера
compose.yaml           приложение и том с БД
```

Модель данных описана в [server/prisma/schema.prisma](../server/prisma/schema.prisma),
кому какие данные принадлежат — в [README](../README.md#пользователи-и-данные).

## Миграции

Схема меняется через Prisma, каждая миграция хранится в Git:

```bash
cd server
DATABASE_URL=file:./data/job-autopilot.db npx prisma migrate dev --name <что-изменилось>
```

`migrate dev` применяется к локальной БД разработки. Docker и CI запускают только `migrate deploy`.
Не удаляй файл БД и не делай `migrate reset` ради чистого старта: тесты используют свою временную БД.

## Генератор доменов

Типы полей берутся из `schema.prisma`, а `prisma/domains.json` выбирает поля и операции CRUD.
Сейчас список пуст. Домены вакансий пишутся вручную, потому что сгенерированный CRUD
не фильтрует записи по владельцу. Генератор остаётся для простых справочников.
Подробнее — в [generator.md](generator.md).

## Проверки

```bash
npm run check          # обе части
npm run check:server   # генерация, TypeScript, архитектурные границы, тесты, сборка
npm run check:client   # типы Vue, соглашения кода и стилей, тесты, сборка
```

Интеграционные тесты сервера сами создают временный файл SQLite, накатывают на него миграции
и удаляют его после прогона. Рабочую БД и `DATABASE_URL` они не трогают.
GitHub Actions запускает эти же проверки на Node.js 22.

## Документация

- [Архитектура](architecture.md) — структура, нейминг, DI и бизнес-слой.
- [Клиент](frontend.md) — Options API, состояние, SCSS и адаптивность.
- [Авторизация](authentication.md) — регистрация, JWT, cookie, сессии и роли.
- [Генератор](generator.md) — Prisma как источник DTO и схем.
- [План сборщика](collector-plan.md) — модульная архитектура источников вакансий.
