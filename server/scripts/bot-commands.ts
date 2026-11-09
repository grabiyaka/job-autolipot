import { escapeHtml } from '../plugins/telegram.js';
import type { InlineKeyboard } from '../plugins/telegram.js';
import type { Answer } from '../src/answers/AnswerTypes.js';
import { usd } from '../src/applications/ApplicationRules.js';
import type { ApplicationView, FillReport, QuestionView, SubmitReport, SubmittedView } from '../src/applications/ApplicationTypes.js';
import type { JobStatus, PipelineJob } from '../src/jobs/JobTypes.js';
import { isPipelineTask, pipelineTasks } from '../src/schedules/ScheduleService.js';
import type { PipelineTask, ScheduleView, TaskRun, TaskRunStatus, TaskTrigger } from '../src/schedules/ScheduleService.js';
import { agentSiteLabel, agentSourceId } from '../src/searches/AgentSites.js';
import type { Search, SearchInput } from '../src/searches/SearchService.js';

/**
 * Commands of the Telegram bot and the texts it answers with. Pure: text in, command or message out,
 * so parsing and wording are tested without Telegram. Messages are HTML: every dynamic part is escaped.
 */

// ── Commands ──

export type RawOptions = Readonly<Record<string, number | boolean>>;

export type BotCommand =
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'status' }>
  | Readonly<{ kind: 'run'; task: PipelineTask; options: RawOptions }>
  | Readonly<{ kind: 'stop' }>
  | Readonly<{ kind: 'schedules' }>
  | Readonly<{ kind: 'schedule'; task: PipelineTask; cron: string; options: RawOptions }>
  | Readonly<{ kind: 'toggle'; task: PipelineTask; enabled: boolean }>
  | Readonly<{ kind: 'searches' }>
  | Readonly<{ kind: 'addSearch'; search: SearchInput }>
  | Readonly<{ kind: 'queued' }>
  | Readonly<{ kind: 'answers' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'answer'; question: string; answer: string }>
  | Readonly<{ kind: 'invalid'; message: string }>;

/** Names in commands → TaskOptions keys. */
const optionNames: Record<string, { key: string; type: 'integer' | 'flag' }> = {
  limit: { key: 'limit', type: 'integer' },
  threshold: { key: 'threshold', type: 'integer' },
  max: { key: 'maxMinutes', type: 'integer' },
  easy: { key: 'easyApply', type: 'flag' },
  'skip-collect': { key: 'skipCollect', type: 'flag' },
};

const yes = ['1', 'yes', 'true', 'on', 'да'];
const no = ['0', 'no', 'false', 'off', 'нет'];

/** `key=value` words; a flag may go without a value (`easy`). Ranges and task fit are checked by the schedule rules. */
export function parseOptions(words: readonly string[]): RawOptions | string {
  const options: Record<string, number | boolean> = {};
  for (const word of words) {
    const [name = '', value, ...extra] = word.split('=');
    const option = optionNames[name.toLowerCase()];
    if (!option || extra.length) return `Неизвестный флаг «${word}». Флаги: limit=N threshold=N max=минуты easy skip-collect.`;
    if (option.type === 'flag') {
      const raw = (value ?? 'yes').toLowerCase();
      if (!yes.includes(raw) && !no.includes(raw)) return `${name} — да или нет.`;
      options[option.key] = yes.includes(raw);
    } else {
      const number = Number(value);
      if (value === undefined || value === '' || !Number.isInteger(number)) return `${name}=N — целое число.`;
      options[option.key] = number;
    }
  }
  return options;
}

const taskList = pipelineTasks.join(' | ');

/** Plain text: the bot escapes it. */
export const searchUsage = 'Формат: /search <ключевые слова> | <локация> | +node,typescript | -java,qa | all\n'
  + 'Обязательны только ключевые слова. +слова — хотя бы одно должно быть в названии вакансии, -слова — отсеять, '
  + 'all — не только Easy Apply (по умолчанию только Easy Apply). Пример: /search node.js | Remote | +node,backend | -java\n'
  + 'Другие биржи через агента (задача /hunt): /search @indeed node.js | Ireland | +node | -java — '
  + '@indeed, @djinni, @remoteok, @wellfound или @https://адрес-страницы-поиска';

const termList = (text: string): string[] => text.split(',').map((term) => term.trim()).filter(Boolean);

/**
 * `/search node.js | Remote | +node,typescript | -java,qa | all`: a saved LinkedIn search. Parts after the
 * keywords go in any order; a part without a marker is the location. Easy Apply only unless `all`.
 * `/search @indeed node.js | Ireland | +node | -java`: a search the agent runs on that site (task hunt);
 * the site is a known id or an https address, checked when the search is saved.
 */
export function parseSearch(body: string): SearchInput | string {
  const siteMatch = body.trim().match(/^@(\S+)\s*(.*)$/s);
  const site = siteMatch?.[1];
  const [keywords = '', ...parts] = (siteMatch ? siteMatch[2]! : body).split('|').map((part) => part.trim());
  if (!keywords) return searchUsage;
  let location: string | undefined;
  let includeTitle: string[] = [];
  let excludeTitle: string[] = [];
  let easyApplyOnly = true;
  for (const part of parts) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (part.startsWith('+')) includeTitle = [...includeTitle, ...termList(part.slice(1))];
    else if (part.startsWith('-') || part.startsWith('−')) excludeTitle = [...excludeTitle, ...termList(part.slice(1))];
    else if (lower === 'all' || lower === 'все') easyApplyOnly = false;
    else if (lower === 'easy') easyApplyOnly = true;
    else if (location === undefined) location = part;
    else return `Две локации: «${location}» и «${part}». ${searchUsage}`;
  }
  if (site !== undefined) return { source: agentSourceId, site, keywords, ...(location ? { location } : {}), includeTitle, excludeTitle };
  return { source: 'linkedin', keywords, ...(location ? { location } : {}), includeTitle, excludeTitle, easyApplyOnly };
}

function task(word: string | undefined, usage: string): PipelineTask | string {
  if (!word) return usage;
  return isPipelineTask(word) ? word : `Неизвестная задача «${word}»: ${taskList}.`;
}

/** Null for plain text that is not a command. `/cmd@BotName` is accepted as `/cmd`. */
export function parseCommand(text: string): BotCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head = '', ...words] = trimmed.split(/\s+/);
  const name = head.slice(1).split('@')[0]!.toLowerCase();
  const invalid = (message: string): BotCommand => ({ kind: 'invalid', message });

  switch (name) {
    case 'start':
    case 'help':
      return { kind: 'help' };
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'searches':
      return { kind: 'searches' };
    case 'search': {
      const search = parseSearch(trimmed.slice(head.length).trim());
      return typeof search === 'string' ? invalid(search) : { kind: 'addSearch', search };
    }
    case 'queued':
      return { kind: 'queued' };
    case 'answers':
      return { kind: 'answers' };
    case 'pending':
      return { kind: 'pending' };
    case 'collect':
    case 'score':
    case 'cycle':
    case 'hunt':
    case 'apply': {
      // A menu shortcut: `/cycle limit=20` is `/run cycle limit=20`.
      const options = parseOptions(words);
      return typeof options === 'string' ? invalid(options) : { kind: 'run', task: name as PipelineTask, options };
    }
    case 'run': {
      const found = task(words[0], `Какую задачу запустить: /run ${taskList} [limit=N threshold=N max=минуты easy skip-collect]`);
      if (!isPipelineTask(found)) return invalid(found);
      const options = parseOptions(words.slice(1));
      return typeof options === 'string' ? invalid(options) : { kind: 'run', task: found, options };
    }
    case 'schedule': {
      if (!words.length) return { kind: 'schedules' };
      const found = task(words[0], '');
      if (!isPipelineTask(found)) return invalid(found);
      const cron = words.slice(1, 6);
      if (cron.length < 5) return invalid(`Нужно 5 полей cron: /schedule ${found} 0 9,18 * * * (минута час день месяц день_недели).`);
      const options = parseOptions(words.slice(6));
      return typeof options === 'string' ? invalid(options) : { kind: 'schedule', task: found, cron: cron.join(' '), options };
    }
    case 'on':
    case 'off': {
      const found = task(words[0], `Какое расписание: /${name} ${taskList}`);
      if (!isPipelineTask(found)) return invalid(found);
      return words.length > 1 ? invalid(`Лишнее после задачи: /${name} ${found}`) : { kind: 'toggle', task: found, enabled: name === 'on' };
    }
    case 'answer': {
      const body = trimmed.slice(head.length).trim();
      const split = body.indexOf('=');
      const question = split < 0 ? '' : body.slice(0, split).trim();
      const answer = split < 0 ? '' : body.slice(split + 1).trim();
      return question && answer ? { kind: 'answer', question, answer } : invalid('Формат: /answer <вопрос> = <ответ>');
    }
    default:
      return invalid(`Неизвестная команда /${name}. Список: /help`);
  }
}

// ── Buttons ──

export type BotCallback =
  | Readonly<{ kind: 'schedule'; action: 'on' | 'off' | 'delete'; id: string }>
  | Readonly<{ kind: 'search'; action: 'on' | 'off' | 'delete'; id: string }>
  | Readonly<{ kind: 'application'; action: ApplicationAction; id: string }>;

/**
 * ✅ send (ready), ❌ give up (ready or manual), «✅ подал сам» (manual); the remote browser of a manual job:
 * «🖥 Открыть браузер», «✅ Аккаунт готов» (close it and run the agent again), «✖️ Закрыть».
 */
export type ApplicationAction = 'submit' | 'reject' | 'appliedByHand' | 'openBrowser' | 'accountReady' | 'closeBrowser';
const applicationActions: Record<string, ApplicationAction> = {
  ok: 'submit', no: 'reject', me: 'appliedByHand', br: 'openBrowser', acc: 'accountReady', bx: 'closeBrowser',
};

/** Callback data must fit 64 bytes: a short prefix and a UUID. */
export function parseCallback(data: string | undefined): BotCallback | null {
  const application = data?.match(/^a:(ok|no|me|br|acc|bx):([\w-]{1,48})$/);
  if (application) return { kind: 'application', action: applicationActions[application[1]!]!, id: application[2]! };
  const match = data?.match(/^([sq]):(on|off|del):([\w-]{1,48})$/);
  if (!match) return null;
  const [, kind, action, id] = match as unknown as [string, 's' | 'q', 'on' | 'off' | 'del', string];
  return { kind: kind === 's' ? 'schedule' : 'search', action: action === 'del' ? 'delete' : action, id };
}

// ── Texts ──

/**
 * The «/» menu in Telegram (setMyCommands): commands that make sense to tap without typing anything.
 * Names: a–z, 0–9 and _, up to 32 characters; descriptions up to 256.
 */
export const menuCommands: ReadonlyArray<Readonly<{ command: string; description: string }>> = [
  { command: 'start', description: 'Как пользоваться: с чего начать и все команды' },
  { command: 'status', description: 'Что сейчас происходит: вакансии, задача, запуски' },
  { command: 'cycle', description: 'Полный цикл: собрать → оценить → в To Apply' },
  { command: 'collect', description: 'Только собрать вакансии по поискам' },
  { command: 'score', description: 'Только оценить найденные вакансии' },
  { command: 'hunt', description: 'Другие биржи через агента: собрать → оценить → To Apply' },
  { command: 'apply', description: 'Заполнить формы из To Apply (отправка после ✅)' },
  { command: 'stop', description: 'Остановить текущую задачу' },
  { command: 'pending', description: 'Ждут ✅, подать вручную, вопросы агента' },
  { command: 'queued', description: '10 лучших отобранных вакансий' },
  { command: 'searches', description: 'Сохранённые поиски (вкл/выкл, удалить)' },
  { command: 'search', description: 'Добавить поиск LinkedIn или @биржи (покажет формат)' },
  { command: 'schedule', description: 'Расписания запусков' },
  { command: 'answers', description: 'Банк ответов на вопросы форм' },
  { command: 'answer', description: 'Добавить ответ (покажет формат)' },
  { command: 'help', description: 'Список команд' },
];

export const helpText = [
  '<b>job-autopilot</b>',
  '',
  '<b>С чего начать</b>',
  '1. /search node.js | Remote | +node,backend | -java — добавить поиск LinkedIn (/searches — список)',
  '2. /cycle — собрать вакансии, оценить, лучшие уйдут в To Apply (/status — как идёт, /stop — остановить)',
  '3. /search @indeed … и /hunt — другие биржи через агента (indeed, djinni, remoteok, wellfound, любой https-адрес)',
  '4. /queued — посмотреть отобранные',
  '5. /apply — агент заполнит формы и пришлёт каждую на ✅; /pending — что ждёт решения',
  '6. По расписанию: /schedule cycle 0 9,18 * * *, затем /on cycle (так же /schedule hunt …, /on hunt)',
  'Все команды — в меню «/» слева от поля ввода.',
  '',
  '<b>Запуск</b> (флаги необязательны: limit=N threshold=N max=минуты easy skip-collect)',
  '/cycle — сбор → оценка → To Apply; /cycle skip-collect — без сбора',
  '/collect — только сбор · /score — только оценка',
  '/hunt limit=N — другие биржи через агента Claude: выдача → описания новых (до N на поиск, по умолчанию 10) → оценка → To Apply;',
  '  только чтение, капча или вход — сайт пропускается до следующего прогона',
  '/apply limit=N — заполнить формы из To Apply (LinkedIn Easy Apply и внешние сайты: Greenhouse, Lever…); перед отправкой агент останавливается',
  '  ✅ на внешней форме — агент заполнит её заново и отправит (пара минут); ❌ — отказаться',
  '  🖐 «подать вручную» (Workday, аккаунт, капча) — ссылка; подали сами — «✅ подал сам», отмечу в Job-Tracker;',
  '  нужен аккаунт — «🖥 Открыть браузер»: зарегистрируйтесь в браузере агента, «✅ Аккаунт готов» — агент продолжит',
  `/run ${taskList} [флаги] — то же самое длинной формой`,
  '/stop — остановить текущую задачу (дописав текущую страницу или вакансию)',
  '',
  '<b>Смотреть</b>',
  '/status — вакансии по статусам, текущая задача, последние запуски, ближайшие по расписанию',
  '/queued — 10 лучших отобранных',
  '/pending — что ждёт ✅, что подать вручную, открытые вопросы агента (кнопки; на вопрос — ответ реплаем)',
  '',
  '<b>Поиски</b>',
  '/searches — сохранённые поиски с кнопками вкл/выкл и 🗑',
  '/search node.js | Remote | +node,backend | -java — добавить поиск LinkedIn (только Easy Apply; all — все вакансии)',
  '/search @indeed node.js | Ireland | +node | -java — поиск через агента (@djinni, @remoteok, @wellfound, @https://…); собирает /hunt',
  '',
  '<b>Расписания</b>',
  '/schedule — расписания с кнопками',
  '/schedule cycle 0 9,18 * * * — создать или заменить расписание (новое выключено)',
  '/on cycle · /off cycle — включить или выключить расписание',
  '',
  '<b>Ответы</b>',
  '/answers — банк ответов; /answer &lt;вопрос&gt; = &lt;ответ&gt; — добавить',
].join('\n');

/** Date and time in the schedule's zone, e.g. «05.11 09:00». */
export function localTime(at: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(typeof at === 'string' ? new Date(at) : at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}.${part('month')} ${part('hour')}:${part('minute')}`;
}

export function minutesAgo(since: Date | string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
}

const statusMarks: Record<TaskRunStatus, string> = { running: '⏳', ok: '✅', error: '⚠️', aborted: '⏹', busy: '⛔' };
const triggerNames: Record<TaskTrigger, string> = { manual: 'вручную', schedule: 'по расписанию' };
const statusOrder: readonly JobStatus[] = ['found', 'scored', 'queued', 'rejected', 'skipped', 'applying', 'needs_input', 'manual', 'applied', 'failed'];

export type StatusData = Readonly<{
  counts: Readonly<Record<JobStatus, number>>;
  total: number;
  /** «занято: …» of the running task, or null. */
  current: string | null;
  runs: readonly TaskRun[];
  schedules: readonly ScheduleView[];
  timezone: string;
}>;

/** What the running task is doing, collected by the runner from its output. */
export type TaskProgress = Readonly<{
  task: string;
  startedAt: Date;
  stage: 'collect' | 'hunt' | 'score' | 'apply' | null;
  stageStartedAt: Date | null;
  /** The last line of the collector: «linkedin «node.js» стр. 3: карточек 25, новых 12». */
  collectLine: string | null;
  scored: number;
  queued: number;
  /** The last scored job: «− 35 Senior Engineer — Acme». */
  lastScored: string | null;
}>;

const stageNames: Record<NonNullable<TaskProgress['stage']>, string> = { collect: 'сбор', hunt: 'сбор через агента', score: 'оценка', apply: 'подача' };

/** Plain text (statusText escapes it): the task, its stage and the last step. */
export function progressText(progress: TaskProgress, now: Date): string {
  const head = `${progress.task}, запущено ${minutesAgo(progress.startedAt, now)} мин назад`;
  if (!progress.stage) return head;
  const stage = `этап: ${stageNames[progress.stage]}${progress.stageStartedAt ? ` (${minutesAgo(progress.stageStartedAt, now)} мин)` : ''}`;
  const details: string[] = [];
  if (progress.stage === 'collect') details.push(progress.collectLine ?? 'открываю поиск…');
  if (progress.stage === 'hunt') details.push(progress.collectLine ?? 'агент открывает выдачу…');
  if (progress.stage === 'score') {
    details.push(`оценено ${progress.scored}, в queued ${progress.queued}; остаток — found выше`);
    if (progress.lastScored) details.push(`последняя: ${progress.lastScored}`);
  }
  if (progress.stage === 'apply') details.push('агент заполняет формы; итог придёт отчётом');
  return [`${head}, ${stage}`, ...details.map((line) => `  ${line}`)].join('\n');
}

export function runLine(run: TaskRun, timezone: string): string {
  const first = run.summary?.split('\n').find((line) => line.trim() && line.trim() !== 'Итог цикла:')?.trim();
  return `${statusMarks[run.status]} ${localTime(run.startedAt, timezone)} ${run.task} ${triggerNames[run.trigger]}`
    + (first ? ` — ${escapeHtml(first)}` : '');
}

export function statusText(data: StatusData): string {
  const counts = statusOrder.filter((status) => data.counts[status]).map((status) => `${status} ${data.counts[status]}`);
  const upcoming = data.schedules.filter((schedule) => schedule.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .map((schedule) => `${localTime(schedule.nextRunAt!, schedule.timezone)} ${schedule.task}`);
  return [
    `<b>Вакансии</b>: всего ${data.total}${counts.length ? ` — ${counts.join(', ')}` : ''}`,
    `<b>Сейчас</b>: ${data.current ? escapeHtml(data.current) : 'ничего не выполняется'}`,
    '<b>Последние запуски</b>:',
    ...(data.runs.length ? data.runs.map((run) => `  ${runLine(run, data.timezone)}`) : ['  пока не было']),
    `<b>По расписанию</b>: ${upcoming.length ? upcoming.join(', ') : 'включённых расписаний нет'}`,
  ].join('\n');
}

const optionText = (options: object): string => {
  const words = Object.entries(options).map(([key, value]) => (value === true ? key : `${key}=${value}`));
  return words.length ? ` (${words.join(' ')})` : '';
};

export function scheduleLine(schedule: ScheduleView): string {
  const state = schedule.enabled
    ? `вкл, следующий ${schedule.nextRunAt ? localTime(schedule.nextRunAt, schedule.timezone) : '—'}`
    : 'выкл';
  const last = schedule.lastRunAt ? `; последний ${localTime(schedule.lastRunAt, schedule.timezone)} ${schedule.lastStatus ? statusMarks[schedule.lastStatus] : ''}` : '';
  return `<b>${schedule.task}</b> <code>${escapeHtml(schedule.cron)}</code> ${escapeHtml(schedule.timezone)}${escapeHtml(optionText(schedule.options))} — ${state}${last}`;
}

export function schedulesMessage(schedules: readonly ScheduleView[]): { text: string; keyboard: InlineKeyboard } {
  if (!schedules.length) {
    return { text: 'Расписаний нет. Создать: /schedule cycle 0 9,18 * * *', keyboard: [] };
  }
  return {
    text: ['<b>Расписания</b>', ...schedules.map(scheduleLine)].join('\n'),
    keyboard: schedules.map((schedule) => [
      schedule.enabled
        ? { text: `⏸ выключить ${schedule.task}`, data: `s:off:${schedule.id}` }
        : { text: `▶️ включить ${schedule.task}`, data: `s:on:${schedule.id}` },
      { text: `🗑 удалить ${schedule.task}`, data: `s:del:${schedule.id}` },
    ]),
  };
}

export function scheduleSaved(schedule: ScheduleView, created: boolean): string {
  const hint = schedule.enabled ? `выключить: /off ${schedule.task}` : `включить: /on ${schedule.task}`;
  return `${created ? 'Создано' : 'Заменено'}: ${scheduleLine(schedule)}\n${hint}`;
}

export function searchesMessage(searches: readonly Search[]): { text: string; keyboard: InlineKeyboard } {
  if (!searches.length) return { text: 'Сохранённых поисков нет. Добавить: /search node.js | Remote', keyboard: [] };
  return {
    text: ['<b>Сохранённые поиски</b>', ...searches.map((search, index) =>
      `${index + 1}. ${search.enabled ? '✅' : '⏸'} ${searchLine(search)}`), '', 'Добавить: /search'].join('\n'),
    keyboard: searches.map((search, index) => [
      search.enabled
        ? { text: `⏸ ${index + 1}. выключить`, data: `q:off:${search.id}` }
        : { text: `▶️ ${index + 1}. включить`, data: `q:on:${search.id}` },
      { text: `🗑 ${index + 1}. удалить`, data: `q:del:${search.id}` },
    ]),
  };
}

/** «linkedin «node.js» (Remote) easy apply +node −java» or «@indeed «node.js» (Ireland)», escaped. */
export function searchLine(search: Search): string {
  const where = search.source === agentSourceId ? `@${agentSiteLabel(search.site)}` : search.source;
  const name = `${where} «${search.keywords}»${search.location ? ` (${search.location})` : ''}`;
  const flags = [search.easyApplyOnly ? 'easy apply' : '', search.includeTitle.length ? `+${search.includeTitle.join(',')}` : '',
    search.excludeTitle.length ? `−${search.excludeTitle.join(',')}` : ''].filter(Boolean).join(' ');
  return `${escapeHtml(name)}${flags ? ` ${escapeHtml(flags)}` : ''}`;
}

export function queuedText(jobs: readonly Pick<PipelineJob, 'score' | 'title' | 'company' | 'url'>[], heading = 'Лучшие отобранные'): string {
  if (!jobs.length) return 'В queued пока пусто.';
  return [`<b>${heading}</b>`, ...jobs.map((job, index) =>
    `${index + 1}. <b>${job.score ?? '—'}</b> ${escapeHtml(job.title)} — ${escapeHtml(job.company)}\n   ${escapeHtml(job.url)}`)].join('\n');
}

export function answersText(answers: readonly Answer[]): string {
  if (!answers.length) return 'Банк ответов пуст. Добавить: /answer &lt;вопрос&gt; = &lt;ответ&gt;';
  return ['<b>Банк ответов</b>', ...answers.map((item) =>
    `• ${escapeHtml(item.question)}\n  → ${escapeHtml(item.answer)}${item.origin === 'telegram' ? ' (telegram)' : ''}`)].join('\n');
}

// ── Applying ──

const applyStops: Record<FillReport['stopped'], string> = {
  end: 'подходящих вакансий больше нет',
  limit: 'лимит запусков агента',
  budget: 'дневной лимит затрат (APPLY_MAX_USD_PER_DAY)',
  aborted: 'остановлено по /stop или по времени',
};

/** Report lines of an apply run (plain text, the report escapes them). */
export function applyReportLines(report: FillReport): string[] {
  const lines = report.resent.map((item) => `Job-Tracker: ${item.title} — ${item.result}`);
  if (!report.lines.length) lines.push('Подходящих вакансий в To Apply нет.');
  for (const line of report.lines) lines.push(`${line.status}: ${line.title} — ${line.company}. ${line.note}`);
  if (report.submitted.length) lines.push(`Отправлено агентом: ${report.submitted.length} — вопросы, ответы и скриншоты ниже.`);
  if (report.manual.length) lines.push(`Подать вручную: ${report.manual.length} — ссылки ниже; подали — «✅ подал сам».`);
  lines.push(`Итог: ${applyStops[report.stopped]}; сегодня потрачено ${usd(report.spentTodayMicros)} из ${usd(report.budgetMicros)}.`);
  return lines;
}

const filledText = (application: ApplicationView) => application.filled.map((item) => `• ${escapeHtml(item.field)}: ${escapeHtml(item.value)}`);

/** An escaped `<a href>`; the text is the link's host (the whole address when it does not parse). */
export function linkTo(url: string): string {
  let host = url;
  try { host = new URL(url).host || url; } catch { /* not a URL: show it as it is */ }
  return `<a href="${escapeHtml(url).replaceAll('"', '&quot;')}">${escapeHtml(host)}</a>`;
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Limits of the field summary of an external form: per value and for the whole message (Telegram allows 4096). */
export const fieldValueMax = 150;
export const externalMessageMax = 3500;

const externalHint = '✅ — агент заполнит форму заново и отправит (пара минут); ❌ — отказаться.';

/** An external form waiting for ✅: the host as a link and «field: value» lines cut to fit one message. */
function externalReadyText(application: ApplicationView): string {
  const head = [
    `🌐 <b>Внешняя форма заполнена, ждёт ✅</b>: ${escapeHtml(application.jobTitle)} — ${escapeHtml(application.company)}`,
    `Форма: ${linkTo(application.applyUrl ?? application.url)}`,
  ];
  const tail = [
    ...(application.summary ? ['', escapeHtml(cut(application.summary, 500))] : []),
    '',
    externalHint,
  ];
  return withFields(head, application, tail);
}

/**
 * A form the agent sent itself (APPLY_AUTO_SUBMIT): the link, the Job-Tracker result and every question
 * with the answer it gave; the screenshots follow as an album.
 */
export function submittedMessage(sent: SubmittedView): string {
  const { application } = sent;
  const head = [
    `🚀 <b>Отправлено агентом</b>: ${escapeHtml(application.jobTitle)} — ${escapeHtml(application.company)}`,
    `Форма: ${linkTo(application.applyUrl ?? application.url)}`,
    `Job-Tracker: ${escapeHtml(sent.tracker)}`,
    '',
    '<b>Вопросы и ответы</b>:',
  ];
  const tail = [
    ...(application.summary ? ['', escapeHtml(cut(application.summary, 500))] : []),
    '',
    sent.screenshots.length ? `Скриншоты формы: ${sent.screenshots.length} — ниже.` : 'Скриншотов нет: агент их не сделал или браузер не смог.',
  ];
  return withFields(head, application, tail);
}

/** head, «• field: value» lines of the filled form cut to fit one message (with «…и ещё N полей»), tail. */
function withFields(head: readonly string[], application: Pick<ApplicationView, 'filled'>, tail: readonly string[]): string {
  const fields = application.filled.map((item) => `• ${escapeHtml(cut(item.field, fieldValueMax))}: ${escapeHtml(cut(item.value, fieldValueMax))}`);
  if (!fields.length) return [...head, '(агент не перечислил поля)', ...tail].join('\n');
  // Room for the fields and a «…и ещё N полей» line.
  let room = externalMessageMax - [...head, ...tail].join('\n').length - 40;
  const shown: string[] = [];
  for (const line of fields) {
    if (line.length + 1 > room) break;
    shown.push(line);
    room -= line.length + 1;
  }
  const more = fields.length - shown.length;
  return [...head, ...shown, ...(more ? [`…и ещё ${more} ${fieldsWord(more)}`] : []), ...tail].join('\n');
}

function fieldsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return 'полей';
  if (ones === 1) return 'поле';
  return ones >= 2 && ones <= 4 ? 'поля' : 'полей';
}

/** A filled form waiting for ✅, with the fields the agent filled and the two buttons. */
export function readyMessage(application: ApplicationView): { text: string; keyboard: InlineKeyboard } {
  const keyboard = [[{ text: '✅ отправить', data: `a:ok:${application.id}` }, { text: '❌ отказаться', data: `a:no:${application.id}` }]];
  if (application.kind === 'external') return { text: externalReadyText(application), keyboard };
  return {
    text: [
      `📝 <b>Заполнено, ждёт ✅</b>: ${escapeHtml(application.jobTitle)} — ${escapeHtml(application.company)}`,
      escapeHtml(application.url),
      ...(application.filled.length ? filledText(application) : ['(агент не перечислил поля)']),
      ...(application.summary ? ['', escapeHtml(application.summary)] : []),
    ].join('\n'),
    keyboard,
  };
}

/** A job only the owner can apply to (an account, a captcha, Workday…): the reason, the link and two buttons. */
export function manualMessage(application: ApplicationView): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      `🖐 <b>Подать вручную</b>: ${escapeHtml(application.jobTitle)} — ${escapeHtml(application.company)}`,
      ...(application.note ? [`Причина: ${escapeHtml(cut(application.note, 500))}`] : []),
      `Ссылка: ${linkTo(application.applyUrl ?? application.url)}`,
      '',
      'Подали сами — «✅ подал сам», отмечу в Job-Tracker; не будете — «❌ не подаю».',
      'Нужен аккаунт — «🖥 Открыть браузер»: зарегистрируйтесь в браузере агента, и он продолжит сам.',
    ].join('\n'),
    keyboard: [
      [{ text: '✅ подал сам', data: `a:me:${application.id}` }, { text: '❌ не подаю', data: `a:no:${application.id}` }],
      [{ text: '🖥 Открыть браузер', data: `a:br:${application.id}` }],
    ],
  };
}

/** The host of a URL for messages and /status; the address itself when it does not parse. */
export function urlHost(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

/** What /status and «занято» show while the remote browser is open. */
export const browserLabel = (url: string): string => `браузер (${urlHost(url)})`;

/**
 * The remote browser is open: the page as a Telegram Mini App (an https link; a plain link otherwise),
 * «✅ Аккаунт готов» and «✖️ Закрыть».
 */
export function browserOpenedMessage(applicationId: string, applyUrl: string, link: string, idleMinutes: number): { text: string; keyboard: InlineKeyboard } {
  const open = link.startsWith('https://') ? { text: '🖥 Открыть', webApp: link } : { text: '🖥 Открыть', url: link };
  return {
    text: `🖥 Браузер открыт: ${escapeHtml(urlHost(applyUrl))}. Зарегистрируйся / войди, затем «✅ Аккаунт готов». `
      + `Сессия закроется через ${idleMinutes} мин без действий.`,
    keyboard: [[open], [{ text: '✅ Аккаунт готов', data: `a:acc:${applicationId}` }, { text: '✖️ Закрыть', data: `a:bx:${applicationId}` }]],
  };
}

/** What /status and «занято» show while ✅ runs: the job, and for an external form that it is filled again. */
export function submitLabel(application: Pick<ApplicationView, 'jobTitle' | 'company' | 'kind'> | null): string {
  if (!application) return 'submit';
  const job = `submit: ${application.jobTitle} — ${application.company}`;
  return application.kind === 'external' ? `${job} (внешняя форма: заполняю заново и отправляю)` : job;
}

export function questionMessage(question: QuestionView): string {
  return [
    `❓ <b>Вопрос агента</b> (${escapeHtml(question.jobTitle)} — ${escapeHtml(question.company)}):`,
    escapeHtml(question.text),
    `Форма: ${linkTo(question.applyUrl)}`,
    '',
    'Ответьте реплаем на это сообщение: ответ попадёт в банк ответов. Когда ответите на все вопросы вакансии, '
      + 'агент сразу заполнит форму заново по черновику и вашему ответу.',
  ].join('\n');
}

export function submitResultText(report: SubmitReport): string {
  const mark = report.application.status === 'applied' || report.application.status === 'submitted' ? '✅' : '⚠️';
  return `${mark} <b>${escapeHtml(report.application.jobTitle)}</b> — ${escapeHtml(report.application.company)}: ${escapeHtml(report.message)}`;
}
