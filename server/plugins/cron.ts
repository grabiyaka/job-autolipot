import { Cron } from 'croner';
import type { CronCalendar } from '../src/schedules/ScheduleTypes.js';

/** True when Intl knows the IANA time zone. */
function knownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Cron expressions through croner: parsing, time zones and summer/winter time are the library's job. */
export const cronCalendar: CronCalendar = {
  check(cron, timezone) {
    if (!knownTimezone(timezone)) return `Неизвестный часовой пояс «${timezone}» (нужно имя IANA, например Europe/Dublin).`;
    try {
      new Cron(cron, { timezone, paused: true });
      return null;
    } catch (error) {
      return `Неверное выражение cron «${cron}»: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  next(cron, timezone, after) {
    return new Cron(cron, { timezone, paused: true }).nextRun(after);
  },
};
