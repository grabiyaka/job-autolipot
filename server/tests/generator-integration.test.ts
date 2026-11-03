import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { createAuthFixture, testAuth, type AuthHeaders } from './auth-fixture.js';
import { ApplicationError } from '../framework/core/errors.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { TaskRepository } from '../src/tasks/TaskRepository.js';
import { TaskService } from '../src/tasks/TaskService.js';
import type { Task, TaskPage } from '../src/tasks/TaskTypes.js';

// Explicit opt-in, as in the other database suites. Never use the running demo DB.
const databaseUrl = process.env.TEST_DATABASE_URL;
let managerHeaders: AuthHeaders;
let guestHeaders: AuthHeaders;
let adminHeaders: AuthHeaders;
let foreignHeaders: AuthHeaders;

describe.skipIf(!databaseUrl)('Generated CRUD: PostgreSQL and HTTP', () => {
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;
  const prefix = `generator-test-${randomUUID()}-`;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL must point to a disposable migrated database.');
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await database.$connect();
    server = await buildServer({ databaseUrl, auth: testAuth, logger: false });
    auth = await createAuthFixture(server, database);
    managerHeaders = auth.managerHeaders;
    guestHeaders = auth.guestHeaders;
    adminHeaders = auth.adminHeaders;
    foreignHeaders = auth.foreignHeaders;
  }, 20_000);

  afterAll(async () => {
    await server?.close();
    await auth?.dispose();
    if (database) {
      await database.task.deleteMany({ where: { title: { startsWith: prefix } } });
      await database.$disconnect();
    }
  });

  async function createTask(input: Record<string, unknown> = {}) {
    const response = await server.inject({
      method: 'POST', url: '/api/tasks', headers: managerHeaders,
      payload: { title: `${prefix}${randomUUID()}`, ...input },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Task>();
  }

  it('uses Prisma defaults and supports create, read, update, delete', async () => {
    const task = await createTask();
    expect(task).toMatchObject({
      description: null, completed: false, priority: 0, status: 'OPEN', dueAt: null, tags: [],
    });
    expect(task.id).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(task.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(task.updatedAt))).toBe(false);

    const read = await server.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: managerHeaders });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual(task);

    const changes = {
      title: `${prefix}updated`, description: 'Plain generated CRUD', completed: true,
      priority: 7, status: 'IN_PROGRESS', dueAt: '2030-05-04T10:30:00.000Z', tags: ['backend', 'generated'],
    };
    const update = await server.inject({
      method: 'PATCH', url: `/api/tasks/${task.id}`, headers: managerHeaders, payload: changes,
    });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.json()).toMatchObject({ ...changes, id: task.id, createdAt: task.createdAt });
    expect(await database.task.findUnique({ where: { id: task.id } })).toMatchObject({
      ...changes, dueAt: new Date(changes.dueAt),
    });

    const remove = await server.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, headers: adminHeaders });
    expect(remove.statusCode, remove.body).toBe(204);
    expect(remove.body).toBe('');
    expect(await database.task.findUnique({ where: { id: task.id } })).toBeNull();
    expect((await server.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: managerHeaders })).statusCode).toBe(404);
  });

  it('preserves explicit false, zero, null and empty arrays when updating', async () => {
    const task = await createTask({
      completed: true, priority: 9, description: 'Clear this',
      dueAt: '2030-01-01T00:00:00.000Z', tags: ['clear'],
    });
    const payload = { completed: false, priority: 0, description: null, dueAt: null, tags: [] };
    const response = await server.inject({
      method: 'PATCH', url: `/api/tasks/${task.id}`, headers: managerHeaders, payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ...payload, id: task.id, title: task.title });
    expect(await database.task.findUnique({ where: { id: task.id } })).toMatchObject(payload);
  });

  it('normalizes DateTime input and returns ISO strings through both API and HTTP', async () => {
    const task = await createTask({ dueAt: '2030-04-05T10:20:00+03:00', status: 'DONE' });
    expect(task.dueAt).toBe('2030-04-05T07:20:00.000Z');
    const service = new TaskService(new TaskRepository(database), () => {});
    const read = await service.get(task.id, undefined);
    expect(read.dueAt).toBe(task.dueAt);
    expect(typeof read.createdAt).toBe('string');
  });

  it('rejects missing required input, invalid values and fields excluded from writes', async () => {
    const initialCount = await database.task.count();
    const invalidInputs: Record<string, unknown>[] = [
      {}, { title: null }, { title: 42 },
      { title: `${prefix}bad`, unknownField: 'surprise' },
      { title: `${prefix}bad`, id: randomUUID() },
      { title: `${prefix}bad`, createdAt: '2030-01-01T00:00:00.000Z' },
      { title: `${prefix}bad`, updatedAt: '2030-01-01T00:00:00.000Z' },
      { title: `${prefix}bad`, completed: 'false' },
      { title: `${prefix}bad`, priority: 1.5 },
      { title: `${prefix}bad`, priority: 2_147_483_648 },
      { title: `${prefix}bad`, status: 'NOT_A_STATUS' },
      { title: `${prefix}bad`, dueAt: 'tomorrow' },
      { title: `${prefix}bad`, tags: 'tag' },
      { title: `${prefix}bad`, tags: [1] },
      { title: `${prefix}bad`, tags: null },
    ];
    for (const payload of invalidInputs) {
      const response = await server.inject({ method: 'POST', url: '/api/tasks', headers: managerHeaders, payload });
      expect(response.statusCode, `${JSON.stringify(payload)}: ${response.body}`).toBe(400);
    }
    expect(await database.task.count()).toBe(initialCount);
  });

  it('rejects empty patches, immutable IDs and wrong field types without changes', async () => {
    const task = await createTask();
    for (const payload of [{}, { id: randomUUID() }, { title: null }, { completed: 'false' }, { priority: null }, { status: 'INVALID' }]) {
      const response = await server.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: managerHeaders, payload });
      expect(response.statusCode, response.body).toBe(400);
    }
    const read = await server.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: managerHeaders });
    expect(read.json()).toEqual(task);
  });

  it('returns stable bounded pages and rejects invalid pagination', async () => {
    await createTask();
    await createTask();
    await createTask();
    const list = (query: string) => server.inject({ method: 'GET', url: `/api/tasks${query}`, headers: managerHeaders });
    const firstResponse = await list('?page=1&limit=2');
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const first = firstResponse.json<TaskPage>();
    expect(first).toMatchObject({ page: 1, limit: 2, total: await database.task.count() });
    expect(first.items).toHaveLength(2);
    const second = (await list('?page=2&limit=2')).json<TaskPage>();
    expect(second.items).toHaveLength(2);
    expect(second.items.every(task => !first.items.some(item => item.id === task.id))).toBe(true);
    expect((await list('?page=1&limit=2')).json()).toEqual(first);

    for (const query of ['?page=0', '?page=-1', '?page=1.5', '?page=no', '?limit=0', '?limit=101', '?limit=1.5', '?limit=no', '?unknown=1']) {
      const response = await list(query);
      expect(response.statusCode, `${query}: ${response.body}`).toBe(400);
    }
  });

  it('returns 404 for missing IDs in get, update and delete', async () => {
    const id = randomUUID();
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const response = await server.inject({
        method, url: `/api/tasks/${id}`, headers: method === 'DELETE' ? adminHeaders : managerHeaders,
        ...(method === 'PATCH' ? { payload: { completed: true } } : {}),
      });
      expect(response.statusCode, `${method}: ${response.body}`).toBe(404);
    }
  });

  it('separates guest reads, manager writes and admin deletion through route middleware', async () => {
    const task = await createTask();
    const operations = [
      { method: 'GET', url: '/api/tasks' },
      { method: 'GET', url: `/api/tasks/${task.id}` },
      { method: 'POST', url: '/api/tasks', payload: { title: `${prefix}role-access` } },
      { method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { completed: true } },
      { method: 'DELETE', url: `/api/tasks/${task.id}` },
    ] as const;
    for (const operation of operations) {
      const anonymous = await server.inject(operation);
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      const unassigned = await server.inject({ ...operation, headers: foreignHeaders });
      expect(unassigned.statusCode, unassigned.body).toBe(403);
      const guest = await server.inject({ ...operation, headers: guestHeaders });
      expect(guest.statusCode, guest.body).toBe(operation.method === 'GET' ? 200 : 403);
      const manager = await server.inject({ ...operation, headers: managerHeaders });
      expect(manager.statusCode, manager.body).toBe(operation.method === 'DELETE' ? 403 : operation.method === 'POST' ? 201 : 200);
    }
    expect(await database.task.findUnique({ where: { id: task.id } })).toMatchObject({ completed: true });
    const remove = await server.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, headers: adminHeaders });
    expect(remove.statusCode, remove.body).toBe(204);
    expect(await database.task.findUnique({ where: { id: task.id } })).toBeNull();
  });

  it('enforces injected authorization before repository access even without HTTP', async () => {
    const denied = new ApplicationError('TEST_ACCESS_DENIED', 'No permission for this operation.', 403);
    const calls: string[] = [];
    const forbiddenRepository = new Proxy(new TaskRepository(database), {
      get() { throw new Error('Repository accessed before authorization.'); },
    });
    const service = new TaskService<{ userId: string }>(forbiddenRepository, (operation, context) => {
      calls.push(operation);
      expect(context).toEqual({ userId: 'reader' });
      throw denied;
    });
    const context = { userId: 'reader' };
    const operations = [
      () => service.list({}, context),
      () => service.get('missing', context),
      () => service.create({ title: `${prefix}denied-direct` }, context),
      () => service.update('missing', { completed: true }, context),
      () => service.delete('missing', context),
    ];
    for (const operation of operations) await expect(operation()).rejects.toBe(denied);
    expect(calls).toEqual(['list', 'get', 'create', 'update', 'delete']);
  });
});
