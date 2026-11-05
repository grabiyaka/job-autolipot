# Подача — домен `applications` и `npm run apply`

Агент (`claude -p` на DeepSeek с Playwright MCP, [agent-runner.md](agent-runner.md)) заполняет форму
LinkedIn Easy Apply по профилю из Job-Tracker и банку ответов и **останавливается перед Submit**.
Отправка идёт только после твоего ✅: кнопка в Telegram, `--submit` в CLI или `POST /api/applications/:id/submit`.
Автоподачи без ✅ нет.

Задание и решения: [phase3/d-applications.md](phase3/d-applications.md), [phase3/decisions.md](phase3/decisions.md).

## Поток ✅

```
JT To Apply (GET /api/ai/jobs?evaluation=any, старые первыми, все страницы)
  └─ локальная вакансия: по trackerId → по URL (тогда связывается с JT) → иначе создаётся queued
       └─ берутся вакансии в found / scored / rejected / queued
            └─ не linkedin.com/jobs/view/<id> → skipped «внешняя подача», агент не запускается
            └─ вакансия applying, попытка running → агент mode=fill
                 ready_to_submit → попытка ready (ждёт ✅), вакансия остаётся applying
                 needs_input     → вопросы open, вакансия needs_input
                 external/closed/not_eligible → вакансия skipped (причина в why)
                 blocked/failed/ошибка агента → вакансия failed
                 остановка (Ctrl+C, /stop) или агент недоступен → вакансия снова queued
✅ → агент mode=submit, --resume той же сессии
       submitted → попытка submitted, вакансия applied → JT POST /api/ai/jobs/:id/application
```

Вакансии берутся по одной: браузер один, на весь прогон берётся lock `server/data/browser.lock`
(общий со сборщиком и ботом). Занят — ошибка «браузер занят: …».

## Статусы

Попытка (`applications.status`):

| Статус | Значит |
|---|---|
| `running` | агент работает |
| `ready` | форма заполнена, ждёт ✅ |
| `submitted` | отправлено на LinkedIn, отметка в JT ещё не прошла (JT не ответил или 409) |
| `applied` | отправлено и отмечено в JT (или вакансии в JT уже нет в To Apply, или она не из JT) |
| `needs_input` | агент задал вопросы |
| `skipped` | внешняя подача, вакансия закрыта, не проходит вопрос-фильтр, ❌ |
| `failed` | агент не справился, остановлен, ответ не по схеме |

Вопрос (`questions.status`): `open` → `answered` (ответ ушёл в банк) → `used` (следующее заполнение
вакансии началось с ним). Причина итога — в `applications.note`, ответ агента (поля, сводка, журнал
инструментов) — в `applications.result`.

## Правила агента

Системный промпт собирает `ApplicationRules.buildApplyPrompt` (основа — [phase3/c-agent-runner.md](phase3/c-agent-runner.md#системный-промпт-агента-из-пробы)):

- только linkedin.com и диалог Easy Apply; нет кнопки — `external`, вакансия закрыта — `closed`;
- Submit и Enter запрещены (и хуком тоже), на последнем шаге — `ready_to_submit`;
- ответы только из профиля и банка; обязательное без ответа — `needs_input` со списком вопросов;
  необязательное и сопроводительное письмо — пусто;
- обязательный вопрос-фильтр, на который правдивый ответ «нет» **однозначно** следует из профиля или банка
  (офис в другом городе, нет права на работу) — `not_eligible`, вакансия `skipped`; не однозначно — `needs_input`;
- email: LinkedIn предзаполняет контакты; если в списке есть email из профиля или банка — выбрать его,
  иначе оставить и написать в `summary`;
- согласие на обработку данных — только если разрешено банком; прочие заявления, аккаунты, пароли,
  оплата, капча — `blocked`;
- резюме — путь копии из `agentUploadPath(APPLY_CV_FILE)` (`<AGENT_CWD>/files/…`), не ранее загруженный файл;
- страницу смотреть только `browser_snapshot` / `browser_find`, файловые инструменты (Read, Grep) запрещены;
- зарплата — правило из банка, а без него — по вилке вакансии, не ниже минимума профиля ([a-answers.md](phase3/a-answers.md#правило-по-зарплате)).

Профиль, ответы и описание вакансии передаются в тегах `<profile>`, `<answers>`, `<job_posting>` с
экранированием `< > &`; URL в задании агенту пересобирается из числового id вакансии.

Режим `submit` продолжает сессию заполнения (`--resume`) с тем же промптом, где вместо запрета —
«нажми Submit ровно один раз на шаге проверки». Если агент не подтвердил отправку: был разрешённый
клик — вакансия `failed` («проверьте в LinkedIn»), не было — вакансия снова `queued` и заполнится заново.

## Job-Tracker ✅

После отправки — `POST /api/ai/jobs/:trackerId/application` с `channel: linkedin_easy_apply`,
`agentName: job-autopilot/deepseek`, `appliedAt` — время отправки:

| Ответ JT | Попытка |
|---|---|
| 201 `created`, 200 `already_applied` | `applied` |
| 404 (вакансию уже перевели вручную) | `applied`, пометка «уже нет в To Apply», не повторяется |
| 409 (неоднозначная компания, дубль) | остаётся `submitted`, причина в отчёте; разберите в JT |
| сеть, 5xx, 429 | остаётся `submitted` |

Попытки `submitted` отправляются в JT заново в начале каждого `npm run apply` / `/run apply`.
Вакансия в autopilot становится `applied` сразу после отправки, независимо от JT.

## Ответы на вопросы

Ответ (реплаем в Telegram, `--answer` или `POST /api/questions/:id/answer`) записывается в банк ответов
(`origin: telegram` или `manual`) по формулировке вопроса агента. Когда закрыт последний вопрос попытки,
вакансия снова `queued`: следующий прогон начнёт форму заново (через часы старая сессия ненадёжна —
форма LinkedIn закрывается), уже с новым ответом в банке.

## Лимиты

- `APPLY_MAX_PER_RUN` (по умолчанию 5) — запусков агента за один прогон (`--limit`, `limit=N` в боте);
  внешние подачи без агента не считаются.
- `APPLY_MAX_USD_PER_DAY` (по умолчанию 0.5) — сумма `applications.costMicros` с 00:00 UTC; перед каждым
  запуском агента проверяется, превышено — прогон останавливается («дневной лимит затрат»).
- Таймаут одного запуска — `APPLY_TIMEOUT_MS` плагина агента.
- Стоимость считает плагин по токенам и `DEEPSEEK_PRICE_*`; отправка добавляет свои токены к попытке.

## Команды ✅

```bash
npm run apply -- --user <email> [--limit N] [--job <id>]   # заполнить, стоп перед Submit
npm run apply -- --user <email> --list                     # что ждёт ✅ и открытые вопросы
npm run apply -- --user <email> --submit <applicationId>   # отправить и отметить в JT
npm run apply -- --user <email> --reject <applicationId>   # отказаться: skipped «отклонено вручную»
npm run apply -- --user <email> --answer <questionId> "<ответ>"
```

`--job` — id вакансии в autopilot или в JT; такую вакансию можно повторить и после `failed` / `skipped`.

Telegram: `/run apply [limit=N]`, `/schedule apply <cron>`, `/pending`, кнопки ✅ / ❌, ответ реплаем на
вопрос — [telegram.md](telegram.md#подача-).

HTTP (нужен вход, видны только свои записи, чужие — 404):

| Метод | Что |
|---|---|
| `GET /api/applications` | свои попытки, новые первыми |
| `GET /api/applications/:id` | попытка с полями и вопросами |
| `POST /api/applications/:id/submit` | отправить `ready` (не `ready` — 409); в HTTP-сервере агент читает настройки из `.env` при первом запуске |
| `POST /api/questions/:id/answer` | `{answer}` → банк, вопрос закрыт |

## Настройки

| Переменная | Значение |
|---|---|
| `APPLY_MAX_PER_RUN` | 5 |
| `APPLY_MAX_USD_PER_DAY` | 0.5 |
| `APPLY_CV_FILE` | имя файла резюме в `/srv/agent-files`; пусто — единственный PDF там |
| `JOB_TRACKER_URL`, `JOB_TRACKER_TOKEN` | обязательны: профиль и To Apply; токену нужен scope `ai:applications:write` |
| `DEEPSEEK_*`, `AGENT_CWD`, `PLAYWRIGHT_MCP_URL`, `APPLY_TIMEOUT_MS` | плагин агента, [agent-runner.md](agent-runner.md) |

## Код

| Файл | Что делает |
|---|---|
| `server/src/applications/ApplicationTypes.ts` | статусы, отчёты, `ApplicationApi` для бота и CLI |
| `server/src/applications/ApplicationContracts.ts` | порты `ApplyAgent`, `ApplyBrowser`, настройки |
| `server/src/applications/ApplicationRules.ts` | кандидаты, промпт, схема ответа, исходы → статусы, бюджет |
| `server/src/applications/ApplicationService.ts` | `fillNext`, `submit`, `reject`, `answerQuestion`, повтор отметки в JT |
| `server/src/applications/ApplicationRepository.ts` | `applications`, `questions` по владельцу вакансии |
| `server/src/applications/ApplicationRoutes.ts`, `…Controller.ts` | HTTP |
| `server/framework/composition/create-applications.ts` | плагин агента как `ApplyAgent`, lock, путь резюме, сборка для CLI и бота |
| `server/scripts/apply.ts`, `apply-cli.ts` | CLI |
| `server/plugins/job-tracker.ts` | `listToApply`, `markApplied` |

Тесты (`tests/applications.test.ts`, `tests/bot.test.ts`) — на фейковом агенте и фейковом JT, без
`claude`, браузера и сети.

## Ещё не сделано 📝

- живая проверка на 5 вакансиях Easy Apply (заполнение, ✅, отметка в JT);
- автоподача без ✅ (флаг расписания `autoSubmit`) — позже, по решению пользователя;
- скриншоты до/после (`screenshotBefore/After`) не заполняются: скриншоты MCP пишет в папку, закрытую для этого пользователя.
