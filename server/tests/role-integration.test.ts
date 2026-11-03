import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { createApplication } from '../framework/composition/create-application.js';
import type { Actor } from '../framework/core/actor.js';
import { userRoles } from '../framework/core/roles.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { createAuthFixture, testAuth, testPassword } from './auth-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Application roles with real JWT sessions and PostgreSQL', () => {
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;
  let application: ReturnType<typeof createApplication>;
  const taskIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL must point to a disposable migrated database.');
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await database.$connect();
    server = await buildServer({ databaseUrl, auth: testAuth });
    auth = await createAuthFixture(server, database);
    application = createApplication(database, { now: () => new Date() }, { next: randomUUID });
  }, 20_000);

  afterAll(async () => {
    if (database) {
      await database.task.deleteMany({ where: { id: { in: taskIds } } });
      await database.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await server?.close();
    await auth?.dispose();
    await database?.$disconnect();
  });

  async function createTask() {
    const task = await database.task.create({ data: { title: `Role access test ${randomUUID()}` } });
    taskIds.push(task.id);
    return task;
  }

  it.each(userRoles)('enforces the task operation matrix for %s over HTTP', async role => {
    const task = await createTask();
    const headers = auth[`${role}Headers`];
    const canRead = role !== 'foreign';
    const canWrite = role === 'admin' || role === 'manager';
    const list = await server.inject({ method: 'GET', url: '/api/tasks', headers });
    expect(list.statusCode, list.body).toBe(canRead ? 200 : 403);
    const get = await server.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers });
    expect(get.statusCode, get.body).toBe(canRead ? 200 : 403);

    const title = `Role-specific create ${role} ${randomUUID()}`;
    const create = await server.inject({ method: 'POST', url: '/api/tasks', headers, payload: { title } });
    if (create.statusCode === 201) taskIds.push(create.json<{ id: string }>().id);
    expect(create.statusCode, create.body).toBe(canWrite ? 201 : 403);
    expect(await database.task.count({ where: { title } })).toBe(canWrite ? 1 : 0);

    const update = await server.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers, payload: { priority: 42 } });
    expect(update.statusCode, update.body).toBe(canWrite ? 200 : 403);
    expect((await database.task.findUniqueOrThrow({ where: { id: task.id } })).priority).toBe(canWrite ? 42 : 0);

    const remove = await server.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, headers });
    expect(remove.statusCode, remove.body).toBe(role === 'admin' ? 204 : 403);
    expect(await database.task.count({ where: { id: task.id } })).toBe(role === 'admin' ? 0 : 1);
  });

  it('requires an identity for every task operation', async () => {
    const task = await createTask();
    for (const options of [
      { method: 'GET' as const, url: '/api/tasks' },
      { method: 'GET' as const, url: `/api/tasks/${task.id}` },
      { method: 'POST' as const, url: '/api/tasks', payload: { title: 'Anonymous write' } },
      { method: 'PATCH' as const, url: `/api/tasks/${task.id}`, payload: { title: 'Anonymous update' } },
      { method: 'DELETE' as const, url: `/api/tasks/${task.id}` },
    ]) {
      const response = await server.inject(options);
      expect(response.statusCode, `${options.method} ${options.url}: ${response.body}`).toBe(401);
    }
  });

  it.each(userRoles)('enforces the same operation matrix when %s calls the service directly', async role => {
    const task = await createTask();
    const actor: Actor = { id: auth[role].id, role };
    if (role === 'foreign') {
      await expect(application.tasks.list({}, actor)).rejects.toMatchObject({ statusCode: 403 });
      await expect(application.tasks.get(task.id, actor)).rejects.toMatchObject({ statusCode: 403 });
    } else {
      expect((await application.tasks.list({}, actor)).total).toBeGreaterThan(0);
      expect((await application.tasks.get(task.id, actor)).id).toBe(task.id);
    }

    const title = `Service access test ${role} ${randomUUID()}`;
    if (role === 'admin' || role === 'manager') {
      const created = await application.tasks.create({ title }, actor);
      taskIds.push(created.id);
      expect((await application.tasks.update(task.id, { priority: 7 }, actor)).priority).toBe(7);
    } else {
      await expect(application.tasks.create({ title }, actor)).rejects.toMatchObject({ statusCode: 403 });
      await expect(application.tasks.update(task.id, { priority: 7 }, actor)).rejects.toMatchObject({ statusCode: 403 });
      expect(await database.task.count({ where: { title } })).toBe(0);
      expect((await database.task.findUniqueOrThrow({ where: { id: task.id } })).priority).toBe(0);
    }

    if (role === 'admin') await application.tasks.delete(task.id, actor);
    else await expect(application.tasks.delete(task.id, actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(await database.task.count({ where: { id: task.id } })).toBe(role === 'admin' ? 0 : 1);
  });

  it('updates all access levels immediately on the same existing JWT cookie', async () => {
    try {
      for (const role of ['guest', 'admin', 'foreign', 'manager'] as const) {
        await database.user.update({ where: { id: auth.manager.id }, data: { role } });
        const current = await server.inject({ method: 'GET', url: '/api/auth/me', headers: auth.managerHeaders });
        expect(current.statusCode, current.body).toBe(200);
        expect(current.json()).toMatchObject({ user: { id: auth.manager.id, role } });
        const general = await server.inject({ method: 'GET', url: '/api/operator/status', headers: auth.managerHeaders });
        expect(general.statusCode, general.body).toBe(role === 'admin' || role === 'manager' ? 200 : 403);
      }
    } finally {
      await database.user.update({ where: { id: auth.manager.id }, data: { role: 'manager' } });
    }
  });

  it('defaults newly stored accounts to foreign and allows an unlinked guest account', async () => {
    const defaultAccount = await database.user.create({
      data: { email: `default-role-${randomUUID()}@example.test`, name: 'Default role', passwordHash: auth.manager.passwordHash },
    });
    userIds.push(defaultAccount.id);
    expect(defaultAccount.role).toBe('foreign');

    const guest = await application.users.create({
      email: `unlinked-guest-${randomUUID()}@example.test`, name: 'Unlinked guest',
      password: testPassword, role: 'guest',
    });
    userIds.push(guest.id);
    expect(guest.role).toBe('guest');
    expect((await database.user.findUniqueOrThrow({ where: { id: guest.id } })).subscriberId).toBeNull();
  });

  it.each(['admin', 'manager', 'foreign'] as const)('rejects subscriber links for %s in the service and database', async role => {
    const email = `invalid-linked-role-${randomUUID()}@example.test`;
    await expect(application.users.create({
      email, name: 'Invalid linked account', password: testPassword, role,
      subscriberId: auth.subscriberAccount.id,
    })).rejects.toMatchObject({ code: 'INVALID_SUBSCRIBER' });
    await expect(database.user.create({
      data: { email, name: 'Invalid linked account', passwordHash: auth.manager.passwordHash, role, subscriberId: auth.subscriberAccount.id },
    })).rejects.toThrow();
    expect(await database.user.count({ where: { email } })).toBe(0);
  });
});
