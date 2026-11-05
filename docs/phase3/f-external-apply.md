# Пакет Е. Подача на внешних сайтах

Статус: 🔧 код и тесты готовы (2026-11-05), живой пилот впереди. Решения — [decisions.md](decisions.md) (строки от 2026-11-05).

## Зачем

Живой `/run apply` 2026-11-05: из 4 вакансий To Apply ни одна не Easy Apply — Workday (F5), сайт компании
(Blackwall), Greenhouse (Karat), вакансия не с LinkedIn (TU Dublin). Подача только через Easy Apply почти
ничего не подаёт.

## Что поддерживаем

| Сайт | Как |
|---|---|
| LinkedIn Easy Apply | как сейчас ([applications.md](../applications.md)) |
| Без аккаунта: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Teamtailor, Personio, простые формы компаний | агент заполняет; ✅ → заполнить заново и отправить |
| С аккаунтом: Workday, iCIMS, Taleo, SuccessFactors; капча; вход по паролю | `manual`: ссылка в Telegram + «✅ подал сам» |

## Поток

```
вакансия из JT To Apply
  ├─ URL linkedin.com/jobs/view/<id> → агент открывает; Easy Apply → как сейчас
  │                                    кнопка Apply ведёт наружу → тот же агент идёт по ней (outcome не external)
  └─ другой URL (вакансия не с LinkedIn) → агент начинает с него
внешняя форма:
  fill   → заполняет всё, стоп перед отправкой → outcome ready_to_submit + сводка полей (поле → значение)
           → попытка ready, kind=external, applyUrl; в Telegram сводка с ✅ / ❌
  ✅     → новый прогон mode=submit_fresh: открыть applyUrl, заполнить заново теми же ответами,
           отправить ровно один раз, подтвердить по странице «спасибо»
  аккаунт/капча/логин → outcome manual (причина, applyUrl) → вакансия manual; в боте ссылка и «✅ подал сам»
```

## Изменения

1. **Защита (`plugins/agent-guard-rules.ts`).** Разрешённые домены попытки: `*.linkedin.com`, домен
   стартового URL и домен, на который ведёт кнопка Apply (фиксируется при первом переходе с LinkedIn),
   плюс список известных ATS (`greenhouse.io`, `lever.co`, `ashbyhq.com`, `workable.com`,
   `smartrecruiters.com`, `teamtailor.com`, `personio.de|com`). Прочие — запрет «report manual».
   - Отправка: на внешнем домене после первого ввода на странице (`type` / `fill_form` / `select` /
     `file_upload`) клик по submit-слову (`submit`, `apply`, `send`, `bewerben`, `postuler`, `enviar`, …)
     в `fill` — запрет. До ввода «Apply» разрешён (он открывает форму).
   - `submit_fresh`: тот же запрет до полного заполнения не нужен, но submit-клик — ровно один.
2. **Агент (`ApplicationService`, промпт).** Новые исходы `manual`; outcome `external` убрать из промпта
   (агент идёт по ссылке сам). В `ready_to_submit` для внешней формы — `fields: [{label, value}]`, `applyUrl`.
   Cover letter — только обязательное поле, иначе пусто. Email и телефон вписываются из профиля.
3. **Схема.** `applications.kind` (`easy_apply` | `external`), `applications.applyUrl`, `fields` (JSON);
   `JobStatus.manual` / `ApplicationStatus.manual` (миграция на копии БД).
4. **Бот.** Сводка полей вместо формы LinkedIn у ✅; `manual` — ссылка и кнопка «✅ подал сам»
   (→ `markApplied`, `channel: company_site_manual`). `/pending` показывает и `manual`.
5. **JT.** `channel` — свободный текст (`docs/AI_API.md` в JT): `company_site` для агента,
   `company_site_manual` для «подал сам». Правок в JT не нужно.

## Пилот до кода в общем потоке

Живой `fill` (без отправки) на 2–3 вакансиях Greenhouse / Lever: проверить, что Playwright MCP видит формы
во `iframe` (Greenhouse часто встроен в сайт компании), что загрузка резюме работает, и сколько стоит
прогон. Только после этого — `submit_fresh` с явным «да, отправляй» пользователя.

## Готово, когда

- `npm run check` зелёный; тесты защиты: чужой домен, submit после ввода, один submit в `submit_fresh`.
- Живой пилот: 3 внешние формы заполнены до `ready`, 1 отправлена с ✅ и отмечена в JT.
- [applications.md](../applications.md), [agent-runner.md](../agent-runner.md), `guide.md` обновлены.
