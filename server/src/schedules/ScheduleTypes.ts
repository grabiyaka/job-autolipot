/**
 * Public boundary of the schedules domain: the cron calendar port that the croner plugin implements.
 *
 * Cron calendar the schedule service asks. Composition backs it with the croner plugin; tests may use
 * the same plugin or a fake. Expressions are the usual five fields (minute hour day month weekday).
 */
export interface CronCalendar {
  /** A readable reason when the expression or the time zone is wrong; null when both are fine. */
  check(cron: string, timezone: string): string | null;
  /** The first run strictly after `after`, read in `timezone`; null when there is none. */
  next(cron: string, timezone: string, after: Date): Date | null;
}
