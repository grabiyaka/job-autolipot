import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireBrowserLock, BrowserBusyError, processAlive } from '../plugins/browser-lock.js';

describe('browser lock', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'browser-lock-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let counter = 0;
  const lockPath = () => path.join(root, `case-${++counter}`, 'browser.lock');
  const now = () => new Date('2026-11-04T09:00:00.000Z');

  it('writes the holder and removes the file on release', () => {
    const file = lockPath();
    const lock = acquireBrowserLock({ task: 'collect', path: file, now });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ task: 'collect', pid: process.pid, startedAt: '2026-11-04T09:00:00.000Z' });
    lock.release();
    lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it('a live holder makes the next one fail with a clear message', () => {
    const file = lockPath();
    const first = acquireBrowserLock({ task: 'apply', path: file, now });
    let error: unknown;
    try { acquireBrowserLock({ task: 'collect', path: file, pid: process.pid + 1 }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(BrowserBusyError);
    expect((error as Error).message).toBe(`браузер занят: apply с 2026-11-04T09:00:00.000Z, pid ${process.pid}`);
    first.release();
    acquireBrowserLock({ task: 'collect', path: file }).release();
  });

  it('takes over a lock of a dead process or an unreadable file', () => {
    const file = lockPath();
    const dead = acquireBrowserLock({ task: 'cycle', path: file, pid: 999_999_999, now });
    expect(dead.holder.pid).toBe(999_999_999);
    const next = acquireBrowserLock({ task: 'collect', path: file, isAlive: (pid) => pid !== 999_999_999 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ task: 'collect', pid: process.pid });
    // The old holder's release must not remove the new lock.
    dead.release();
    expect(existsSync(file)).toBe(true);
    next.release();

    writeFileSync(file, 'garbage');
    acquireBrowserLock({ task: 'collect', path: file }).release();
    expect(existsSync(file)).toBe(false);
  });

  it('is released in finally after a failing task', async () => {
    const file = lockPath();
    const task = async () => {
      const lock = acquireBrowserLock({ task: 'collect', path: file });
      try { throw new Error('task failed'); } finally { lock.release(); }
    };
    await expect(task()).rejects.toThrow('task failed');
    expect(existsSync(file)).toBe(false);
  });

  it('knows a live pid from a dead one', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(999_999_999)).toBe(false);
  });
});
