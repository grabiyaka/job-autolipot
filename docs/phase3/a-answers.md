# Пакет А. Банк ответов — домен `src/answers`

Типовые ответы на вопросы форм, чтобы агент не спрашивал одно и то же. Таблица `answers` уже есть
в схеме (`userId`, `key`, `question`, `answer`, `origin`, `@@unique([userId, key])`).

## Что сделать

1. Домен `server/src/answers` по [server/AGENTS.md](../../server/AGENTS.md): `AnswerRoutes.ts →
   AnswerController.ts → AnswerService.ts → AnswerRepository.ts`, `AnswerRules.ts`, `AnswerTypes.ts`,
   composition в `framework/composition`.
2. `AnswerRules.ts`:
   - `answerKey(question)` — нормализация: NFKC, нижний регистр, убрать `*`, пунктуацию и «шум»
     (`please`, `how many`, `working with`, `do you have`…), схлопнуть пробелы. Так
     «Years of experience working with TypeScript*» и «How many years of TypeScript experience?»
     дают один ключ (`experience typescript years`). Правила нормализации — таблицей в тестах.
   - Ответы-**правила** (не одно значение) хранятся тем же текстом: агент получает их как инструкции
     (зарплата, согласия). Отличать их не нужно — всё уходит агенту списком «вопрос → ответ».
3. HTTP (`authenticatedAccess`, фильтр по владельцу): `GET /api/answers`, `PUT /api/answers`
   (`{question, answer}` → upsert по ключу), `DELETE /api/answers/:id`.
4. `AnswerTypes.ts` → `AnswerApi`: `listForUser(ownerId)`, `upsert(ownerId, question, answer, origin)`.
   Им пользуются подача (пакет Г) и бот (пакет Б: ответ на вопрос агента → `origin: telegram`).
   Если в enum `AnswerOrigin` нет нужного значения — миграция через `prisma migrate dev` на копии БД.
5. CLI `npm run answers -- --user <email> list | set "<вопрос>" "<ответ>" | delete <id>`
   (`server/scripts/answers.ts`, корневой npm-скрипт).
6. Начальные ответы (заводит пользователь командой `set` или скрипт по его просьбе):

| Вопрос | Ответ |
|---|---|
| Years of experience with TypeScript | 1 |
| Email address | illia.herasymets@gmail.com |
| Resume / CV | upload `/srv/agent-files/Illia Herasymets - Current Resume.pdf` |
| Consent to data processing / privacy policy for this application | Yes (разрешено) |
| Other legal declarations, account creation, passwords, payment, captcha | never — stop with blocked |
| Cover letter / message to recruiter (optional) | leave empty |
| Expected salary / rate | правило ниже |

Годы по остальным технологиям пользователь не задавал — агент спросит их при первой встрече
(`needs_input`), ответ сохранится в банк.

## Правило по зарплате

Решение пользователя: ставка зависит от вакансии. Ответ-правило для банка:

> Expected salary: base the number on the posting. If the posting gives a range, answer inside it,
> never below the profile minimum (40 000 EUR/year). If it gives no range, answer the profile target
> (48 000 EUR/year). Convert units when the field asks for them: month = year / 12, hour = year / 2080.
> If the field allows text, give a range and say it is open to discussion. If the posting's range is
> entirely below the minimum, do not answer: stop with needs_input.

Минимум и цель берутся из профиля JT (`Salary: min …, target …`), в правиле — для наглядности.
В `ApplicationRules` (пакет Г) это правило передаётся агенту вместе с описанием вакансии.

## Тесты

- `answerKey`: таблица формулировок → ключ (включая звёздочки, регистр, «working with»).
- Интеграционный (`createTestDatabase`): upsert обновляет по ключу, чужие ответы не видны и не
  удаляются (404), HTTP без входа — 401.
- CLI: разбор аргументов.

## Готово, когда

- `npm run answers -- --user illia.herasymets@gmail.com list` показывает начальные ответы;
- `npm run check` зелёный, `npm run architecture` не ослаблен;
- документация: раздел в guide.md, строка в docs/README.md и overview.md (карта кода).

## Открытые вопросы

- Нужен ли просмотр/правка ответов в веб-клиенте сейчас, или хватит CLI и Telegram (`/answers`)?
  Предложение: CLI + Telegram, веб — этап 6.
