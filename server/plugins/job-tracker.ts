import { createHttpRequest, HttpError, pause } from './http.js';
import { TrackerError } from '../src/trackers/TrackerTypes.js';
import type {
  JobTrackerClient, TrackerApplicationInput, TrackerEvaluationInput, TrackerMarkResult, TrackerToApplyPage, TrackerJobInput, TrackerJobPage, TrackerProfileContext, TrackerPushResult, TrackerUser,
  TrackerWorklistQuery,
} from '../src/trackers/TrackerTypes.js';

export type JobTrackerConfig = Readonly<{ baseUrl: string; token: string; timeoutMs: number }>;

type BatchItem =
  | { index: number; status: 'created' | 'duplicate_opportunity'; jobId: string }
  | { index: number; status: 'already_applied'; applicationId: string }
  | { index: number; status: 'invalid'; errors?: { path?: (string | number)[]; message?: string }[] };

function trackerError(error: unknown, label: string): TrackerError {
  if (error instanceof HttpError) {
    const { status } = error;
    if (status === 401 || status === 403) return new TrackerError('unauthorized', `Job-Tracker отклонил токен (HTTP ${status}) на ${label}.`, status);
    if (status === 429) return new TrackerError('rate_limited', `Job-Tracker: превышен лимит запросов на ${label}.`, status);
    if (status >= 500) return new TrackerError('unavailable', `Job-Tracker: ошибка сервера (HTTP ${status}) на ${label}.`, status);
    return new TrackerError('rejected', `Job-Tracker отклонил запрос (HTTP ${status}) на ${label}.`, status);
  }
  // The original error is dropped on purpose: nothing from the request can leak into a message.
  const timeout = error instanceof Error && error.name === 'TimeoutError';
  return new TrackerError('unavailable', `Job-Tracker недоступен${timeout ? ' (таймаут)' : ''} на ${label}.`);
}

function pushResult(item: BatchItem): TrackerPushResult {
  switch (item.status) {
    case 'created':
    case 'duplicate_opportunity':
      return { index: item.index, status: item.status, jobId: item.jobId };
    case 'already_applied':
      return { index: item.index, status: 'already_applied', applicationId: item.applicationId };
    case 'invalid':
      return {
        index: item.index, status: 'invalid',
        errors: (item.errors ?? []).map((issue) => [issue.path?.join('.'), issue.message].filter(Boolean).join(': ')),
      };
  }
}

/** Thin client for JT's AI API (docs/AI_API.md in Job-Tracker). No retries: an evaluation must not be appended twice. */
export function createJobTrackerClient(config: JobTrackerConfig): JobTrackerClient {
  const request = createHttpRequest({ userAgent: 'job-autopilot/0.1', timeoutMs: config.timeoutMs, retries: 0, pause });
  const base = config.baseUrl.replace(/\/+$/, '');

  async function call(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.token}`, accept: 'application/json', ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await request(`${base}${path}`, {
        method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 304) throw error;
      throw trackerError(error, `${method} ${path.split('?')[0]}`);
    }
  }

  return {
    async whoami() {
      const body = await (await call('GET', '/api/ai/whoami')).json() as { user: TrackerUser };
      return { user: { id: body.user.id, email: body.user.email, name: body.user.name ?? null } };
    },

    async profileContext(etag): Promise<TrackerProfileContext> {
      let json: Response;
      try {
        json = await call('GET', '/api/ai/profile-context', etag ? { headers: { 'if-none-match': etag } } : {});
      } catch (error) {
        if (error instanceof HttpError && error.status === 304) return { status: 'not_modified' };
        throw error;
      }
      const revision = (await json.json() as { meta: { profileRevision: number } }).meta.profileRevision;
      const markdown = await call('GET', '/api/ai/profile-context?format=markdown', { headers: { accept: 'text/markdown' } });
      const jsonTag = json.headers.get('etag');
      // Both formats share one ETag. Different tags mean the profile changed between the two requests:
      // keep no tag, so the next call fetches everything again.
      const sameProfile = jsonTag !== null && jsonTag === markdown.headers.get('etag');
      return { status: 'modified', markdown: await markdown.text(), revision, etag: sameProfile ? jsonTag : null };
    },

    async pushJobs(items: readonly TrackerJobInput[]) {
      const body = await (await call('POST', '/api/ai/jobs/batch', { body: { items } })).json() as { results: BatchItem[] };
      return body.results.map(pushResult);
    },

    async listJobs(query: TrackerWorklistQuery): Promise<TrackerJobPage> {
      const search = new URLSearchParams({ evaluation: query.evaluation, limit: '100' });
      if (query.cursor) search.set('cursor', query.cursor);
      const body = await (await call('GET', `/api/ai/jobs?${search}`)).json() as { items: { id: string }[]; nextCursor: string | null };
      return { ids: body.items.map((item) => item.id), nextCursor: body.nextCursor ?? null };
    },

    async recordEvaluation(trackerJobId: string, evaluation: TrackerEvaluationInput) {
      const response = await call('PATCH', `/api/ai/jobs/${encodeURIComponent(trackerJobId)}/evaluation`, { body: evaluation });
      await response.body?.cancel();
    },

    async listToApply(cursor?: string | null): Promise<TrackerToApplyPage> {
      const search = new URLSearchParams({ evaluation: 'any', limit: '100' });
      if (cursor) search.set('cursor', cursor);
      type Row = { id: string; jobTitle?: string; companyName?: string; vacancyUrl?: string; source?: string | null };
      const body = await (await call('GET', `/api/ai/jobs?${search}`)).json() as { items: Row[]; nextCursor: string | null };
      return {
        items: body.items.map((row) => ({
          id: row.id, title: row.jobTitle ?? '', company: row.companyName ?? '', url: row.vacancyUrl ?? '', source: row.source ?? null,
        })),
        nextCursor: body.nextCursor ?? null,
      };
    },

    async markApplied(trackerJobId: string, input: TrackerApplicationInput): Promise<TrackerMarkResult> {
      let response: Response;
      try {
        response = await call('POST', `/api/ai/jobs/${encodeURIComponent(trackerJobId)}/application`, { body: input });
      } catch (error) {
        if (error instanceof TrackerError && error.status === 404) return { status: 'not_found' };
        if (error instanceof TrackerError && error.status === 409) return { status: 'conflict', message: error.message };
        throw error;
      }
      const body = await response.json() as { created?: boolean; applicationId?: string };
      return { status: body.created ? 'created' : 'already_applied', applicationId: String(body.applicationId ?? '') };
    },
  };
}
