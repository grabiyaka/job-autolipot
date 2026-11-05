import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One task at a time in the shared agent Chromium (collector, apply, bot): a lock file created with
 * O_EXCL ('wx'), holding the task name, pid and start time. A lock whose pid is no longer alive (or
 * whose file is unreadable) is stale and is taken over; a live one gives BrowserBusyError.
 *
 * The lock only protects tasks of this app on this machine; local-agent's Telegram bot does not know about it.
 */

/** server/data/browser.lock, independent of the working directory. */
export const defaultBrowserLockPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'browser.lock');

export type BrowserLockHolder = Readonly<{ task: string; pid: number; startedAt: string }>;

export class BrowserBusyError extends Error {
  override name = 'BrowserBusyError';
  constructor(readonly holder: BrowserLockHolder) {
    super(`браузер занят: ${holder.task} с ${holder.startedAt}, pid ${holder.pid}`);
  }
}

export type BrowserLockOptions = Readonly<{
  task: string;
  path?: string;
  pid?: number;
  now?: () => Date;
  /** Whether a process is alive; tests replace it. */
  isAlive?: (pid: number) => boolean;
}>;

export type BrowserLock = Readonly<{
  holder: BrowserLockHolder;
  /** Removes the lock if it is still ours; safe to call twice. */
  release(): void;
}>;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(file: string): BrowserLockHolder | null {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null) return null;
    const { task, pid, startedAt } = data as Record<string, unknown>;
    if (typeof task !== 'string' || !Number.isInteger(pid) || (pid as number) <= 0 || typeof startedAt !== 'string') return null;
    return { task, pid: pid as number, startedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    return null;
  }
}

function create(file: string, holder: BrowserLockHolder): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try { writeSync(fd, `${JSON.stringify(holder)}\n`); } finally { closeSync(fd); }
  return true;
}

export function acquireBrowserLock(options: BrowserLockOptions): BrowserLock {
  const file = options.path ?? defaultBrowserLockPath;
  const isAlive = options.isAlive ?? processAlive;
  const holder: BrowserLockHolder = {
    task: options.task, pid: options.pid ?? process.pid, startedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  mkdirSync(path.dirname(file), { recursive: true });

  // Two attempts: the second one after removing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (create(file, holder)) {
      let released = false;
      return {
        holder,
        release() {
          if (released) return;
          released = true;
          try {
            const current = readHolder(file);
            if (current && current.pid === holder.pid && current.startedAt === holder.startedAt) unlinkSync(file);
          } catch { /* already gone */ }
        },
      };
    }
    let current: BrowserLockHolder | null;
    try { current = readHolder(file); } catch { continue; } // removed meanwhile: try again
    if (current && isAlive(current.pid)) throw new BrowserBusyError(current);
    try { unlinkSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const current = (() => { try { return readHolder(file); } catch { return null; } })();
  throw current ? new BrowserBusyError(current) : new Error(`не удалось взять блокировку браузера ${file}`);
}
