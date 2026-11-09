/**
 * Public boundary of the applications domain: attempts to apply to a job through the browser agent,
 * the agent's questions, and what the bot and the CLI get from the service.
 */

/**
 * running → ready (filled, waits for ✅) → submitted (sent, JT not marked yet) → applied;
 * running → needs_input | failed | skipped | manual; ready → skipped (❌) | failed | needs_input | manual;
 * manual (only the owner can apply: an account, a captcha, Workday…) → submitted («✅ подал сам») | skipped (❌).
 */
export const applicationStatuses = ['running', 'ready', 'submitted', 'applied', 'needs_input', 'failed', 'skipped', 'manual'] as const;
export type ApplicationStatus = typeof applicationStatuses[number];

/** Where the form is: LinkedIn's Easy Apply dialog, or a company site / applicant tracking system. */
export const applicationKinds = ['easy_apply', 'external'] as const;
export type ApplicationKind = typeof applicationKinds[number];

/** open → answered (the owner replied, the answer went to the bank) → used (a later fill started with it). */
export const questionStatuses = ['open', 'answered', 'used'] as const;
export type QuestionStatus = typeof questionStatuses[number];

export type FilledField = Readonly<{ field: string; value: string }>;

export type QuestionView = Readonly<{
  id: string;
  applicationId: string;
  jobId: string;
  jobTitle: string;
  company: string;
  /** Where the form is: the attempt's form page, or the job page when the agent gave none. */
  applyUrl: string;
  text: string;
  answer: string | null;
  status: QuestionStatus;
  telegramMessageId: string | null;
  createdAt: string;
  answeredAt: string | null;
}>;

export type ApplicationView = Readonly<{
  id: string;
  jobId: string;
  jobTitle: string;
  company: string;
  url: string;
  status: ApplicationStatus;
  kind: ApplicationKind;
  /**
   * The form page the agent stopped on: an external ✅ starts there (submit_fresh), a `manual` attempt
   * gives it to the owner. Null until the agent answered.
   */
  applyUrl: string | null;
  /** What the agent filled in (from its answer); empty until it answered. */
  filled: FilledField[];
  /** The agent's summary in Russian, or the reason of the outcome. */
  summary: string | null;
  note: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costMicros: number;
  startedAt: string;
  finishedAt: string | null;
}>;

export type ApplicationDetails = ApplicationView & Readonly<{ questions: QuestionView[] }>;

/** One line of a fill run: which job, what happened. */
export type FillLine = Readonly<{
  jobId: string;
  title: string;
  company: string;
  /** Null when the job was skipped without running the agent (external application). */
  applicationId: string | null;
  status: ApplicationStatus;
  note: string;
  costMicros: number;
}>;

export type FillStop = 'end' | 'limit' | 'budget' | 'aborted';

export type TrackerResend = Readonly<{ applicationId: string; title: string; result: string; ok: boolean }>;

export type FillReport = Readonly<{
  lines: FillLine[];
  stopped: FillStop;
  /** Spent today (UTC day) including this run, micro-dollars. */
  spentTodayMicros: number;
  budgetMicros: number;
  /** Earlier submits whose mark in Job-Tracker was sent again in this run. */
  resent: TrackerResend[];
  /** Attempts of this run that wait for ✅, and the questions this run opened. */
  ready: ApplicationView[];
  questions: QuestionView[];
  /** Attempts of this run the owner has to apply to by hand (`manual`, link in `applyUrl`). */
  manual: ApplicationView[];
  /** APPLY_AUTO_SUBMIT: attempts this run sent itself, with the fields, the screenshots and the Job-Tracker result. */
  submitted: SubmittedView[];
}>;

/** A form the agent sent without ✅: what it answered (`application.filled`) and the screenshots of the form. */
export type SubmittedView = Readonly<{
  application: ApplicationView;
  /** Image files, in the order taken; empty when the agent took none or the browser could not take them. */
  screenshots: string[];
  /** What happened in Job-Tracker. */
  tracker: string;
}>;

export type FillOptions = Readonly<{
  /** Agent runs in this call; defaults to APPLY_MAX_PER_RUN. */
  limit?: number;
  /** Only this job (its id here or its Job-Tracker id); it need not be in To Apply. */
  jobId?: string;
  /**
   * With `jobId`: the owner has just created an account / signed in on the job's application site in the agent's
   * browser (the bot's remote browser). The agent starts on the form of the last `manual` attempt and goes on
   * signed in instead of stopping at the account wall.
   */
  accountReady?: boolean;
  signal?: AbortSignal;
}>;

/** What happened in Job-Tracker after a submit. */
export type TrackerMarkOutcome = 'marked' | 'already_applied' | 'not_in_to_apply' | 'conflict' | 'unavailable' | 'not_linked';

export type SubmitReport = Readonly<{
  application: ApplicationView;
  /** Null when the job has no Job-Tracker link or the agent did not submit. */
  tracker: TrackerMarkOutcome | null;
  message: string;
}>;

export type AnswerReport = Readonly<{
  question: QuestionView;
  /** Open questions of the same attempt that are left. */
  remaining: number;
  /** True when this was the last one and the job went back to queued. */
  requeued: boolean;
}>;

/** `manual`: attempts whose job is still waiting for the owner to apply by hand (link in `applyUrl`). */
export type PendingView = Readonly<{ ready: ApplicationView[]; questions: QuestionView[]; manual: ApplicationView[] }>;

/** Applying as the bot, the CLI and HTTP see it; every call acts for the owner and hides others' records (404). */
export interface ApplicationApi {
  /**
   * Fills the next To Apply jobs one by one and stops before Submit (with APPLY_AUTO_SUBMIT: sends them).
   * Throws when the browser is busy.
   */
  fillNext(ownerId: string, options?: FillOptions): Promise<FillReport>;
  /**
   * Sends an attempt waiting for ✅ (`ready`), then marks the job applied in Job-Tracker. Easy Apply
   * resumes the fill session; an external form is filled again from `applyUrl` and sent (submit_fresh).
   */
  submit(ownerId: string, applicationId: string, signal?: AbortSignal): Promise<SubmitReport>;
  /**
   * «✅ подал сам» for a `manual` attempt: the job becomes applied and Job-Tracker is marked with
   * `channel: company_site_manual`. Other statuses — 409.
   */
  markManualApplied(ownerId: string, applicationId: string): Promise<SubmitReport>;
  /** ❌ (from ready, needs_input or manual): the attempt and the job become skipped, «отклонено вручную». */
  reject(ownerId: string, applicationId: string): Promise<ApplicationView>;
  /** Saves the answer to the bank; once all questions of the attempt are answered, the job is queued again. */
  answerQuestion(ownerId: string, questionId: string, answer: string, origin: 'manual' | 'telegram'): Promise<AnswerReport>;
  /** Attempts waiting for ✅, open questions and attempts to apply to by hand. */
  pending(ownerId: string): Promise<PendingView>;
  /** Remembers the Telegram message a question was sent in, so a reply to it finds the question. */
  setQuestionMessage(ownerId: string, questionId: string, messageId: string): Promise<void>;
  /** The open question sent in this Telegram message; null when there is none. */
  findQuestionByMessage(ownerId: string, messageId: string): Promise<QuestionView | null>;
}
