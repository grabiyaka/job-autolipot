# Генерация типизированного CRUD-домена

Генератор создаёт плоский домен из Prisma-модели и явного списка полей API.
Типы полей описываются один раз в `server/prisma/schema.prisma`; `server/prisma/domains.json`
выбирает доступные поля и операции, не дублируя их типы.
Из одних метаданных Prisma получаются TypeScript DTO, проверки сервиса и JSON-схемы HTTP.
Бизнес-правила и права доступа определяет приложение.

**Когда генератор подходит.** Сгенерированный `list` возвращает все записи таблицы и не фильтрует
их по владельцу. В job-autopilot почти все данные принадлежат пользователю (`jobs.userId`,
`answers.userId`), поэтому эти домены пишутся вручную по [соглашениям архитектуры](architecture.md).
Генератор годится для общих справочников без владельца. Сейчас `domains.json` пуст.

Пути внутри backend ниже указаны относительно `server`, а команды запускаются
из корня репозитория. Например, `src/users` означает `server/src/users`.

## Команды

| Команда | Результат |
| --- | --- |
| `npm run domain:generate` | Создать домены или обновить их сгенерированные блоки. |
| `npm run domain:check` | Проверить актуальность блоков, ничего не записывая; устаревший результат даёт ненулевой код выхода. |
| `npm run db:generate` | Сгенерировать Prisma Client, затем домены. |
| `npm run check:server` | Проверить генерацию, TypeScript, архитектуру, серверные тесты и сборку. |
| `npm run check` | Проверить сервер и клиент. |

Генератор доменов не подключается к БД, не создаёт и не применяет миграции.
Корневая команда запускает генератор в `server`: по умолчанию он читает
`server/prisma/schema.prisma` и `server/prisma/domains.json`.
Другие пути можно передать явно; `--schema` принимает файл или папку `.prisma`-файлов:

```bash
npm --prefix server run domain:generate -- --schema prisma/schema.prisma --config prisma/domains.json
npm --prefix server run domain:check -- --root /path/to/project/server
```

## Описать новый домен

Ниже условный новый домен `projects`.
Добавь модель в схему приложения:

```prisma
model Project {
  id        String   @id @default(uuid())
  title     String
  summary   String?
  archived  Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

Добавь элемент в массив `domains` существующего `prisma/domains.json`:

```json
{
  "model": "Project",
  "domain": "projects",
  "route": "/api/projects",
  "read": ["id", "title", "summary", "archived", "createdAt"],
  "create": ["title", "summary", "archived"],
  "update": ["title", "summary", "archived"],
  "operations": ["list", "get", "create", "update", "delete"]
}
```

`read` — явный список полей ответа, обязательно включающий ID. `create` и `update` —
списки разрешённых полей записи; при отсутствии они пустые. Неизвестные поля отклоняются.
Без `operations` включены все пять операций; можно оставить, например, `list` и `get`.
`name` необязателен: задаёт PascalCase-префикс файлов вместо имени модели.
Имена моделей, доменов, префиксы и пути маршрутов не должны конфликтовать между записями.

При включённом `create` все обязательные поля БД без значения по умолчанию должны
войти в `create`. Исключения — `@updatedAt` и списки. Поля с `@default`, nullable-поля
и списки можно не передавать при создании; генератор сохраняет возможность применить default БД.
Поля ID с default и поля `@updatedAt` запрещено включать в запись.
При обновлении все разрешённые поля необязательны, но пустой PATCH недопустим; ID не изменяется.

Выполни `npm run db:generate`, затем отдельно подготовь и примени миграцию БД.
`npm run db:migrate` применяет уже существующие миграции; сам генератор их не создаёт.

## Результат и ручное расширение

```text
src/projects/
  ProjectTypes.ts
  ProjectContracts.ts
  ProjectRepository.ts
  ProjectService.ts
  ProjectController.ts
  ProjectRoutes.ts
```

`*Types.ts` содержит настоящие определения DTO и `*CrudApi<Context>`, без реэкспорта
Prisma-моделей. `*Contracts.ts` содержит контракт репозитория. JSON-схемы физически
находятся в `*Routes.ts`. Инфраструктурные преобразования остаются в репозитории.
Дополнительных папок внутри домена и runtime-зависимости от генератора нет.

Каждый файл содержит защищённый блок между `// <framework:generated sha256=…>`
и `// </framework:generated>`. Его содержимое обновляет генератор.
Вне блока находятся ручные точки расширения: `ProjectApi`, `ProjectService`,
`ProjectRepository`, `ProjectController` и `registerProjectRoutes`.
Классы расширяют сгенерированные `GeneratedProject*`; интерфейс расширяет `ProjectCrudApi`.
Добавляй свои методы, контракты, проверки и маршруты вне блока. Читаемые сценарии
при необходимости размещай рядом в `ProjectRules.ts` и предметных помощниках.

Изменение модели или API-полей делается в Prisma/конфигурации; общее изменение выдаваемого
кода — в `framework/generator`. После этого запускай генерацию.
Ручные секции сохраняются побайтно, но их совместимость с новым контрактом проверяет TypeScript.
Генератор не переносит автоматически старые ручные методы на новую форму API.

## Подключение и доступ

Регистрация домена выполняется явно в `framework/composition`. Генератор не меняет
`create-application.ts` или список маршрутов. Сервису обязательна функция авторизации,
а маршрутам — функция получения типизированного контекста из запроса.
Пример сборки для условного `Project`, с уже подготовленными `prisma` и `server`:

```ts
import { requireActor, type Actor } from '../core/actor.js';
import { requireRole } from '../core/roles.js';

const projects = new ProjectService(
  new ProjectRepository(prisma),
  (operation, actor: Actor) => {
    switch (operation) {
      case 'list':
      case 'get':
        requireRole(actor, 'admin', 'user');
        break;
      default:
        requireRole(actor, 'admin');
    }
  },
);

registerProjectRoutes(server, projects, (request) => requireActor(request.actor));
```

Функция контекста получает `FastifyRequest`; в примере она возвращает Actor,
проверяя наличие входа. Приложение может выбрать другой тип контекста, включая
асинхронное получение через `Promise<Context>`.
Сам сервис получает обычный контекст и вызывает policy перед каждым CRUD-действием,
включая прямые вызовы из других доменов. Показанные роли задаёт сборка приложения;
готовых ролей внутри шаблона нет.

Для начальной HTTP-проверки `registerProjectCrudRoutes` принимает необязательный
четвёртый аргумент `ProjectRouteAccess`. Это частичное соответствие операций
`list/get/create/update/delete` и Fastify `preHandler` (одна функция либо массив).
Тип генерируется вместе с маршрутами и содержит только включённые операции домена.
Настраивай его в ручной секции `ProjectRoutes.ts`, **после** `// </framework:generated>`:

```ts
import { adminAccess } from '../../middlewares/adminAccess.js';
import { authenticatedAccess } from '../../middlewares/authenticatedAccess.js';

export function registerProjectRoutes<Context>(
  server: FastifyInstance,
  api: ProjectApi<Context>,
  context: (request: FastifyRequest) => Context | Promise<Context>,
): void {
  const access = {
    list: authenticatedAccess,
    get: authenticatedAccess,
    create: adminAccess,
    update: adminAccess,
    delete: adminAccess,
  } satisfies ProjectRouteAccess;

  registerProjectCrudRoutes(server, api, context, access);
}
```

`FastifyInstance`, `FastifyRequest`, `ProjectApi` и `ProjectRouteAccess` уже доступны
в этом файле из сгенерированной части. Обёртка выше заменяет её исходную ручную реализацию;
не добавляй вторую функцию с тем же именем. При повторной генерации ручная секция сохраняется.

Если операция отсутствует в `access`, дополнительный `preHandler` для неё не добавляется.
Это не отключает обязательную policy сервиса и функцию получения контекста.
HTTP-уровни и policy должны выражать согласованные ограничения; авторизация сервиса
защищает также прямые вызовы из другого домена. Доступные middleware описаны в [руководстве авторизации](authentication.md#роли-и-middleware-в-маршрутах).
Изменение ручных правил доступа не требует редактирования защищённых блоков или хешей.

Текущий `app.ts` задаёт Fastify `removeAdditional: false` и `coerceTypes: false`.
При подключении к другому серверу сохрани эти настройки, чтобы лишние поля отклонялись,
а значения тела запроса не приводились к другим типам автоматически.

Policy имеет форму `(operation, context) => void | Promise<void>`: она разрешает
операцию в целом, не получает ID, тело запроса или найденную запись.
Для владения отдельной записью, фильтрации по организации/арендатору и предметных ограничений
нужны собственные методы сервиса и репозитория. Сгенерированный `list` сам такую фильтрацию не делает.
Публичные возможности сервиса передаются потребителям через `ProjectApi<Context>`.

## Типы и форматы

| Prisma | Публичный DTO и ввод |
| --- | --- |
| `String`, `Boolean`, `Int`, `Float` | `string`, `boolean`, `number`; целые проверяются по диапазону БД, Float должен быть конечным. |
| Enum | Объединение строковых значений и JSON Schema `enum`. |
| `DateTime` | ISO-строка с часовым поясом, дробная часть до трёх знаков; ответ нормализуется в UTC. |
| `Decimal` | Десятичная строка без экспоненты; проверяются precision/scale. |
| `BigInt` | Строка целого числа в диапазоне знакового 64-битного значения. |
| `Bytes` | Строка base64. |
| `Json` | Собственный JSON-совместимый тип без Prisma-объектов. |
| Nullable и списки | `T \| null` и массивы соответствующих значений. |

Отсутствие необязательного поля и `null` различаются. В nullable `Json` переданный `null`
означает SQL NULL (`Prisma.DbNull`). В обязательном `Json` верхнеуровневый `null` запрещён;
вложенные JSON null разрешены. Отдельного публичного маркера `Prisma.JsonNull` нет.
Дата внутри приложения использует миллисекундную точность JavaScript; произвольная точность БД
через этот API не предоставляется. Для Decimal без явного `@db.Decimal` учитывается `(65, 30)`
согласно [справочнику схемы Prisma](https://www.prisma.io/docs/orm/v7/reference/prisma-schema-reference).

Поддерживается один datasource PostgreSQL или SQLite (приложение использует SQLite)
и один ID типа `String` или `Int`. В SQLite native-атрибуты `@db.*` не используются.
Для PostgreSQL у выбранных полей разрешены native-типы: `Text`, `VarChar`, `Char`, `Uuid`, `Integer`,
`SmallInt`, `DoublePrecision`, `Boolean`, `BigInt`, `Decimal`, `Timestamp`, `Timestamptz`,
`Json`, `JsonB`, `ByteA` — каждый только для соответствующего Prisma-типа.
Явная точность Timestamp/Timestamptz ниже 3 отклоняется. Остальные native-типы,
например `Money`, `Inet`, `Bit`, `Real`, `Date` или `Time`, требуют отдельной реализации.

Relation-поля и вложенные `connect/create/update` не генерируются. Scalar foreign key
можно включить в список записи осознанно; проверка существования FK в БД не заменяет
проверку права связать записи. Составные ID, произвольные фильтры и поиск не поддержаны.

## Безопасное повторение генерации

- Конфигурация выбранных моделей и все защищённые блоки проверяются до первой записи.
  Существующий ручной файл без маркеров или изменённый блок останавливает генерацию.
- Не исправляй хеш вручную. Перенеси свои изменения в ручную секцию и восстанови
  исходный блок из версии в репозитории; затем повтори генерацию.
- Неизменившиеся файлы не записываются. `domain:check` не создаёт файлы или папки.
- Генератор никогда не удаляет домены. Удалённая/переименованная запись конфигурации
  оставляет обнаруживаемые orphan-файлы: сначала явно убери подключение и реши судьбу исходников.
- Запись каждого файла атомарна; весь набор не является транзакцией файловой системы.
  Ошибка I/O или конкурентное изменение во время записи могут оставить часть файлов обновлённой.

Сгенерированные доменные файлы вместе с ручными секциями хранятся в Git.
Это отличается от исключённого из Git каталога `generated/prisma`.
Изменение Prisma-модели может изменить публичный контракт: совместимость и версионирование API
проверяются при разработке, автоматически генератор их не обеспечивает.
Метаданные читаются через `getDMMF` из `@prisma/internals`, закреплённого на **7.10.0**
вместе с Prisma. Это внутренний API Prisma: обновление версии требует проверки генератора.
