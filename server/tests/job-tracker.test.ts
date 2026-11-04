import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobTrackerClient } from '../plugins/job-tracker.js';
import { TrackerError } from '../src/trackers/TrackerTypes.js';

const token = 'jt_test-secret-token-never-in-errors';

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
type Handler = (request: Seen, response: ServerResponse) => void;

describe('Job-Tracker plugin against a fake JT server', () => {
  let server: Server;
  let baseUrl: string;
  let handler: Handler;
  let seen: Seen[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body };
        seen.push(entry);
        handler(entry, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  beforeEach(() => { seen = []; });

  const client = (timeoutMs = 2_000) => createJobTrackerClient({ baseUrl, token, timeoutMs });
  const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
  };

  async function failure(promise: Promise<unknown>): Promise<TrackerError> {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerError);
    const trackerError = error as TrackerError;
    expect(`${trackerError.message} ${trackerError.stack} ${JSON.stringify(trackerError)}`).not.toContain(token);
    return trackerError;
  }

  it('sends the bearer token and reads whoami', async () => {
    handler = (_request, response) => json(response, 200, { user: { id: 'u1', email: 'Me@Example.test', name: null }, authMethod: 'api_token' });
    await expect(client().whoami()).resolves.toEqual({ user: { id: 'u1', email: 'Me@Example.test', name: null } });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/ai/whoami' });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('reads the profile as JSON for the revision and as markdown for the prompt, then polls with the ETag', async () => {
    const etag = '"profile-u1-r3-u1-m2026-11-c1"';
    handler = (request, response) => {
      if (request.headers['if-none-match'] === etag) { response.writeHead(304, { etag }).end(); return; }
      if (request.url.endsWith('format=markdown')) {
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', etag }).end('# Candidate profile\n');
        return;
      }
      json(response, 200, { meta: { profileRevision: 3 } }, { etag });
    };
    await expect(client().profileContext()).resolves.toEqual({ status: 'modified', markdown: '# Candidate profile\n', revision: 3, etag });
    expect(seen.map((request) => request.url)).toEqual(['/api/ai/profile-context', '/api/ai/profile-context?format=markdown']);
    expect(seen[0]!.headers['if-none-match']).toBeUndefined();

    seen = [];
    await expect(client().profileContext(etag)).resolves.toEqual({ status: 'not_modified' });
    expect(seen).toHaveLength(1);
  });

  it('keeps no ETag when the profile changed between the JSON and the markdown request', async () => {
    handler = (request, response) => {
      if (request.url.endsWith('format=markdown')) { response.writeHead(200, { etag: '"r4"' }).end('# r4'); return; }
      json(response, 200, { meta: { profileRevision: 3 } }, { etag: '"r3"' });
    };
    await expect(client().profileContext('"r2"')).resolves.toEqual({ status: 'modified', markdown: '# r4', revision: 3, etag: null });
  });

  it('pushes a batch and maps every per-item outcome', async () => {
    handler = (_request, response) => json(response, 200, {
      contractVersion: 1,
      results: [
        { index: 0, status: 'created', jobId: 'jt-1', possibleDuplicates: [] },
        { index: 1, status: 'duplicate_opportunity', jobId: 'jt-1' },
        { index: 2, status: 'already_applied', applicationId: 'app-1' },
        { index: 3, status: 'invalid', errors: [{ path: ['vacancyUrl'], message: 'vacancyUrl must be a valid URL' }] },
      ],
      summary: { created: 1, duplicate_opportunity: 1, already_applied: 1, invalid: 1 },
    });
    const item = { jobTitle: 'Backend', companyName: 'Acme', vacancyUrl: 'https://jobs.example.test/1' };
    await expect(client().pushJobs([item, item, item, { ...item, vacancyUrl: 'nope' }])).resolves.toEqual([
      { index: 0, status: 'created', jobId: 'jt-1' },
      { index: 1, status: 'duplicate_opportunity', jobId: 'jt-1' },
      { index: 2, status: 'already_applied', applicationId: 'app-1' },
      { index: 3, status: 'invalid', errors: ['vacancyUrl: vacancyUrl must be a valid URL'] },
    ]);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/ai/jobs/batch' });
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]!.body)).toEqual({ items: [item, item, item, { ...item, vacancyUrl: 'nope' }] });
  });

  it('reads a page of the evaluation worklist and passes the cursor back', async () => {
    handler = (request, response) => json(response, 200, {
      contractVersion: 1, currentProfileRevision: 3,
      items: [{ id: 'jt-1', jobTitle: 'A' }, { id: 'jt-2', jobTitle: 'B' }],
      nextCursor: request.url.includes('cursor=') ? null : 'c/1',
    });
    await expect(client().listJobs({ evaluation: 'none' })).resolves.toEqual({ ids: ['jt-1', 'jt-2'], nextCursor: 'c/1' });
    await expect(client().listJobs({ evaluation: 'none', cursor: 'c/1' })).resolves.toEqual({ ids: ['jt-1', 'jt-2'], nextCursor: null });
    expect(seen.map((request) => request.url)).toEqual([
      '/api/ai/jobs?evaluation=none&limit=100', '/api/ai/jobs?evaluation=none&limit=100&cursor=c%2F1',
    ]);
  });

  it('appends an evaluation with PATCH', async () => {
    handler = (_request, response) => json(response, 201, { id: 'ev-1' });
    const evaluation = { score: 85, verdict: 'STRONG_FIT', summary: 'Fits', profileRevision: 3, evaluatorName: 'job-autopilot' } as const;
    await client().recordEvaluation('jt/1', evaluation);
    expect(seen[0]).toMatchObject({ method: 'PATCH', url: '/api/ai/jobs/jt%2F1/evaluation' });
    expect(JSON.parse(seen[0]!.body)).toEqual(evaluation);
  });

  it.each([
    [401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [400, 'rejected'], [404, 'rejected'], [500, 'unavailable'],
  ] as const)('turns HTTP %i into a typed %s error without the token', async (status, kind) => {
    handler = (_request, response) => json(response, status, { error: { code: 'X', message: `echo ${token}` } });
    const error = await failure(client().whoami());
    expect(error).toMatchObject({ kind, status });
    expect(seen).toHaveLength(1);
  });

  it('reports a timeout as unavailable', async () => {
    handler = () => { /* never answers */ };
    const error = await failure(client(100).profileContext());
    expect(error.kind).toBe('unavailable');
    expect(error.message).toContain('таймаут');
  });

  it('reports a refused connection as unavailable', async () => {
    const closed = createJobTrackerClient({ baseUrl: 'http://127.0.0.1:1', token, timeoutMs: 1_000 });
    expect((await failure(closed.pushJobs([]))).kind).toBe('unavailable');
  });
});
