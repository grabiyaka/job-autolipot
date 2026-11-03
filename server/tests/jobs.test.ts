import { describe, expect, it } from 'vitest';
import { canonicalJobUrl, jobStatuses, requireTransition } from '../src/jobs/JobService.js';

describe('Job URL', () => {
  it('drops the fragment and keeps the query that identifies the job', () => {
    expect(canonicalJobUrl(' https://Jobs.Example.test/view?id=7#apply ')).toBe('https://jobs.example.test/view?id=7');
  });

  it.each(['not a url', 'ftp://jobs.example.test/1', 'javascript:alert(1)', 'https://user:pass@jobs.example.test/1'])(
    'rejects %s', (url) => expect(() => canonicalJobUrl(url)).toThrow(expect.objectContaining({ code: 'INVALID_JOB_URL' })),
  );
});

describe('Job status transitions', () => {
  it('follows the main path from found to applied', () => {
    for (const [from, to] of [['found', 'scored'], ['scored', 'queued'], ['queued', 'applying'], ['applying', 'applied']] as const) {
      expect(() => requireTransition(from, to)).not.toThrow();
    }
  });

  it('rejects skipped stages and any change after applied', () => {
    expect(() => requireTransition('found', 'applied')).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => requireTransition('applying', 'queued')).toThrow(expect.objectContaining({ statusCode: 409 }));
    for (const status of jobStatuses) {
      expect(() => requireTransition('applied', status)).toThrow(expect.objectContaining({ code: 'INVALID_JOB_STATUS' }));
    }
  });
});
