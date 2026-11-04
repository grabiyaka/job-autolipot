# Пакет Д. Эндпоинт подачи в Job-Tracker (репозиторий `~/projects/Job-Tracker`)

Сейчас AI API Job-Tracker только создаёт и оценивает вакансии; `docs/AI_API.md` прямо говорит, что агент
**никогда не отмечает поданными**. Чтобы подача из To Apply закрывалась в JT, нужен один эндпоинт.
Работа в другом репозитории, по его правилам и тестам; правило в `AI_API.md` меняется по решению
пользователя (2026-11-03: «правила в JT можно поменять»).

## Что сделать

1. Новый scope токена `ai:applications:write` (`back/src/models/apiToken/apiToken.scopes.ts`).
2. `POST /api/ai/jobs/:id/application`, тело (strict):

```json
{ "appliedAt": "2026-11-04T10:12:00.000Z", "channel": "linkedin_easy_apply", "note": "Подано агентом job-autopilot", "agentName": "job-autopilot/deepseek" }
```

   - превращает JobOpportunity `:id` в Application со статусом `APPLIED` тем же путём, что и кнопка
     в UI (переиспользовать существующий сервис конвертации, не дублировать);
   - вакансия уходит из To Apply;
   - ответы: `201 { contractVersion, applicationId }`; повторный вызов для уже поданной →
     `200 { created: false, reason: "already_applied", applicationId }` (идемпотентно);
     чужая или несуществующая → 404; без scope → 403.
3. `docs/AI_API.md`: убрать «never marks anything as applied», описать scope, эндпоинт, примеры curl,
   добавить шаг в «The agent loop».
4. Тесты в `back/tests/aiJobs.test.ts` (или рядом): создание, идемпотентность, 404 чужой, 403 без scope,
   вакансия исчезла из `GET /api/ai/jobs`.
5. Деплой на прод JT — пользователь; затем перевыпуск токена job-autopilot со scopes
   `ai:profile:read,ai:jobs:read,ai:jobs:write,ai:jobs:evaluate,ai:applications:write`
   (значение — в корневой `.env` как `JOB_TRACKER_TOKEN`, в чат не присылать).

## Готово, когда

- тесты JT зелёные, `AI_API.md` обновлён;
- на проде: вызов для тестовой вакансии превращает её в Application APPLIED (проверяет пользователь).

## Открытые вопросы

- Нужен ли в JT ещё и статус «агент взял в работу» / «нужен ответ», чтобы видеть это в UI JT?
  Предложение: нет — это живёт в autopilot и Telegram; в JT только итог «подано».
