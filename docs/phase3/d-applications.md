# Пакет Г. Подача — домен `src/applications` и `npm run apply`

Берёт вакансию из Job-Tracker To Apply, отдаёт агенту (пакет В) с профилем и банком ответов
(пакет А), записывает попытку, останавливается перед Submit; отправляет после твоего ✅.
Зависит от пакетов А, В и Д.

## Поток

```
JT To Apply (GET /api/ai/jobs?evaluation=any, старые первыми)
  └─ локальная вакансия по trackerId (или по URL; нет — создаётся из JT как queued)
       └─ только linkedin.com/jobs/view/…; иначе → skipped «внешняя подача»
            └─ status applying, applications(running)
                 └─ claude-agent mode=fill
                      ready_to_submit → applications(ready), вакансия ждёт ✅
                      needs_input     → questions(open), вакансия needs_input
                      external/closed → вакансия skipped (причина в why)
                      blocked/failed  → вакансия failed, applications(failed)
✅ (CLI --submit или кнопка в Telegram)
  └─ claude-agent mode=submit, --resume sessionId
       submitted → вакансия applied, JT POST /api/ai/jobs/:id/application (пакет Д)
```

Статусы вакансии уже есть: `queued → applying → applied | needs_input | failed`, плюс `skipped`.
Если для «ждёт ✅» нужен отдельный статус приложения (`ApplicationStatus`), добавить в enum
миграцией (`ready`), а вакансию оставить `applying`.

## Что сделать

1. Домен `server/src/applications`: Routes / Controller / Service / Repository, `ApplicationRules.ts`,
   `ApplicationTypes.ts`, `ApplicationContracts.ts` (порт агента), composition.
2. `ApplicationRules.ts` (чистые функции):
   - `isEasyApplyCandidate(url)` — только `linkedin.com/jobs/view/<id>`;
   - `buildApplyPrompt(profileMarkdown, answers, job, cvPath)` — промпт из [c-agent-runner.md](c-agent-runner.md#системный-промпт-агента-из-пробы),
     ответы и описание вакансии в тегах с экранированием, правило по зарплате из [a-answers.md](a-answers.md#правило-по-зарплате);
   - `decideByOutcome(outcome)` → статус вакансии и попытки;
   - `costMicros(tokens, prices)`.
3. Job-Tracker: в `plugins/job-tracker.ts` — `listJobs({evaluation:'any'})` уже есть; добавить
   `markApplied(jobId, {appliedAt, note})` (эндпоинт пакета Д). В `TrackerApi`: `listToApply(ownerId)`,
   `markApplied(ownerId, trackerId)`.
4. `ApplicationService`:
   - `fillNext(ownerId, {limit, jobId?, signal})` — по одной вакансии (браузер один), lock браузера;
   - `submit(ownerId, applicationId)` — только из `ready`, `--resume`, затем `markApplied` в JT;
     если JT не ответил — вакансия всё равно `applied`, отметка в JT досылается следующим прогоном;
   - `answerQuestion(ownerId, questionId, answer)` — ответ → банк ответов (`origin: telegram|manual`),
     вопрос закрыт; когда все вопросы попытки закрыты, вакансия снова `queued` (следующий `fill` начнёт
     форму заново — продолжать старую сессию через часы ненадёжно, форма LinkedIn закрывается).
   - лимиты: подач за запуск (`APPLY_MAX_PER_RUN`, по умолчанию 5), $ в день (`APPLY_MAX_USD_PER_DAY`,
     по умолчанию 0.5) — считаются по `applications.costMicros`.
5. CLI `server/scripts/apply.ts` + корневой скрипт:
   - `npm run apply -- --user <email> [--limit N] [--job <id>]` — заполнить, стоп перед Submit;
   - `npm run apply -- --user <email> --list` — что ждёт ✅ и какие вопросы открыты;
   - `npm run apply -- --user <email> --submit <applicationId>`;
   - `npm run apply -- --user <email> --answer <questionId> "<ответ>"`.
6. HTTP: `GET /api/applications`, `GET /api/applications/:id`, `POST /api/applications/:id/submit`,
   `POST /api/questions/:id/answer` (`authenticatedAccess`, по владельцу).
7. Бот (дополнение к пакету Б): `/run apply`, сообщение на каждую `ready` с полями (`filled`) и кнопками
   ✅ отправить / ❌ отказаться (❌ → вакансия `skipped`, причина «отклонено вручную»); вопросы агента —
   отдельными сообщениями, ответ реплаем; расписание для `apply`.
8. Автоподача без ✅ — **не в этом пакете**. Включается позже флагом расписания `autoSubmit`, когда
   ты решишь, что доверяешь; по умолчанию выключена.

## Тесты

- `ApplicationRules`: кандидаты, исходы → статусы, стоимость, экранирование в промпте.
- Сервис на фейковом агенте и фейковом JT (`createTestDatabase`): fill → ready → submit → applied +
  `markApplied`; needs_input → answer → queued; external → skipped; лимит $ останавливает прогон;
  `submit` чужой попытки → 404; `submit` не из `ready` → 409.
- CLI: разбор аргументов.

## Готово, когда

- 5 реальных Easy Apply вакансий: формы заполнены правильно, остановлены перед Submit;
- одобренные отправлены (`--submit` или ✅), в JT они стали Application APPLIED и ушли из To Apply;
- вопрос агента пришёл в Telegram, ответ сохранился в банк, следующая подача им воспользовалась;
- `npm run check` зелёный; документация: `docs/applications.md`, guide.md (как подаваться),
  overview.md (этап 3 — работает), дорожная карта.

## Открытые вопросы

- Что делать с вакансией, у которой Easy Apply требует ответа «нет» на обязательный вопрос-фильтр
  (например, «готовы работать в офисе в Берлине?» → нет): `skipped` с причиной, без вопроса тебе?
  Предложение: да, если ответ однозначно следует из профиля (локация, право на работу).
