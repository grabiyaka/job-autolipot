# jwx-framework

Универсальная основа приложения: **Vue 3 Options API**, **Fastify 5**, **Prisma 7**,
**PostgreSQL 17** и строгий **TypeScript**. Явный DI сохраняет автокомплит, домены содержат
свои маршруты, а бизнес-правила читаются отдельно от HTTP и хранения данных.

Клиент показывает вход по JWT и работающий CRUD задач: список, создание, изменение и удаление.
Серверные домены `subscribers`, `readings` и `transactions` сохранены как предметные примеры.
Сущности и роли примеров не определяют архитектуру будущих приложений.

В [песочнице моделей](sandbox/water-billing/README.md) можно сравнивать реализацию
бизнес-сценария разными LLM на одинаковых Rules, сущностях и тестах PostgreSQL.
[Расширенный отчёт эксперимента](sandbox/water-billing/series-2/reports/REPORT.md) содержит результаты,
ревью, токены и оценку стоимости. Песочница использует отдельные БД и не подключена
к рабочим маршрутам приложения.

## Запуск в Docker

Нужны Docker Compose и Node.js 22.12 или новее для команд настройки.

```bash
npm run setup
docker compose up --build -d --wait
docker compose exec api npm run user:create -- --email admin@example.com --name Admin --role admin
```

`setup` создаёт локальный `.env` со случайным JWT-секретом и не перезаписывает существующий файл.
Команда `user:create` спрашивает пароль в терминале: от 12 до 128 символов.
В примере явно создаётся `admin`; без `--role` команда создаёт `manager`.
Общего пароля и публичной регистрации нет.

Открой [приложение](http://localhost:3400), войди созданным пользователем и попробуй задачи.
[Swagger](http://localhost:3400/docs) использует тот же вход;
[health](http://localhost:3400/api/health) проверяет API и соединение с БД.
В Docker Fastify отдаёт клиентскую сборку и API с одного адреса.

Повторный запуск сохраняет пользователей, задачи и историю в PostgreSQL.
`docker compose down` останавливает приложение без удаления данных; `down -v` удаляет том.
Имя Compose-проекта задаётся `COMPOSE_PROJECT_NAME` и по умолчанию равно `jwx-framework`.
При обновлении существующей установки сохрани её прежнее имя в локальном `.env`,
чтобы продолжить использовать тот же том БД.

## Структура

```text
client/
  src/components/      страницы по сущностям и общие UI-компоненты
  src/store/           Pinia
  src/router/          Vue Router
  src/assets/css/      общие стили и SCSS-миксины
server/
  src/                 плоские домены: tasks, readings, transactions…
  framework/           core, composition, HTTP и генератор
  plugins/             недоменные технические возможности
  middlewares/         идентификация и уровни HTTP-доступа
  prisma/              модель, миграции и конфигурация CRUD
  generated/           воспроизводимый Prisma Client, вне Git
Dockerfile             общая сборка frontend и backend
compose.yaml           приложение и PostgreSQL
docs/                  соглашения и руководства
AGENTS.md              инструкции и ссылки на документацию
```

Клиентские компоненты используют `data`, `computed`, `methods` и lifecycle Options API.
SCSS вложен в корневой класс компонента, общие поля и кнопки описаны один раз,
а responsive-миксины расположены рядом со стилями соответствующего элемента.

На сервере зависимости передаются через типизированные конструкторы.
Сервису доступны его репозиторий через контракт и публичные API нужных доменов;
контроллер не получает репозитории. Маршруты и JSON-схемы лежат вместе в `*Routes.ts`.
`*Rules.ts` содержит понятные шаги, технические преобразования — именованные помощники.

Роли приложения — `admin`, `manager`, `guest`, `foreign`. Отдельные middleware
`publicAccess`, `authenticatedAccess`, `guestAccess`, `generalAccess`, `adminAccess`
и `rolesAccess` импортируются прямо в доменные роуты и подключаются через `preHandler`.
В задачах гость читает, менеджер также создаёт и меняет записи, администратор может удалять.
`foreign` имеет вход и профиль, но не доступ к задачам. Матрица и примеры —
в [руководстве авторизации](docs/authentication.md#роли-и-middleware-в-маршрутах).

## Локальная разработка

У клиента и сервера отдельные зависимости и lock-файлы. Все следующие команды выполняются из корня:

```bash
npm run setup
npm run install:all
docker compose up -d --wait database
npm run db:generate
npm run db:migrate
npm run db:seed
npm run build
npm run user:create -- --email admin@example.com --name Admin --role admin
npm run dev
```

Клиент работает на [localhost:5173](http://localhost:5173), API — на `localhost:3400`.
Vite проксирует `/api` на backend; JWT передаётся в HttpOnly cookie, без хранения в localStorage.
`npm run dev` запускает обе части с автоматическим обновлением.
Если контейнер API уже занимает 3400, предварительно останови его: `docker compose stop api`.

В `.env` находятся `DATABASE_URL`, `JWT_SECRET`, `APP_ORIGIN`, дополнительные разрешённые
origins разработки и параметры cookie. `APP_PORT` и `DATABASE_PORT` задают опубликованные
порты Docker. Для HTTPS-развёртывания настрой origin и secure-cookie.
Подробности, срок сессии и создание других ролей — в [руководстве авторизации](docs/authentication.md).

## Генератор доменов

Типы полей берутся из `server/prisma/schema.prisma`; `server/prisma/domains.json` выбирает
поля и операции CRUD. Генератор создаёт шесть плоских файлов домена: DTO в `*Types.ts`,
JSON-схемы в `*Routes.ts` и остальные слои. Повторное описание типов вручную не требуется.

```bash
npm run db:generate
npm run domain:check
```

`db:generate` обновляет Prisma Client и домены; `domain:generate` запускает только генератор доменов.
Ручные расширения вне защищённых блоков сохраняются. Миграции, подключение нового домена
и его политика доступа остаются явными. Подробнее — [генератор доменов](docs/generator.md).

## Проверки

```bash
npm run check
# Отдельно:
npm run check:server
npm run check:client
```

Сервер проверяет актуальность генерации, TypeScript, архитектурные границы, тесты и сборку.
Клиент проверяет типы Vue, соглашения кода и стилей, тесты и сборку.
Для PostgreSQL-интеграций нужна отдельная БД; без `TEST_DATABASE_URL` они пропускаются:

```bash
docker compose exec -T database createdb -U framework framework_test
DATABASE_URL=postgresql://framework:framework_demo@localhost:5547/framework_test npm run db:migrate
TEST_DATABASE_URL=postgresql://framework:framework_demo@localhost:5547/framework_test npm run check:server
```

`createdb` нужен один раз. Тесты не требуют удаления рабочей БД или её истории.
GitHub Actions выполняет проверки обеих частей с Node.js 22 и отдельным PostgreSQL 17.

## Документация

- [Архитектура](docs/architecture.md) — структура, нейминг, зависимости и бизнес-слой.
- [Клиент](docs/frontend.md) — Options API, состояние, SCSS и responsive-миксины.
- [Авторизация](docs/authentication.md) — JWT, cookie, сессии и пользователи.
- [Генератор](docs/generator.md) — Prisma как источник DTO и схем, ручные расширения.
- [Пример Vodogon](docs/examples/vodogon.md) — правила сохранённых предметных доменов.
- [AGENTS.md](AGENTS.md) — инструкции для изменений в репозитории.

Общая основа ещё содержит прикладную модель актора и конкретную сборку примеров.
Их выделение описано как дальнейшая работа, а не как уже готовое независимое ядро.
