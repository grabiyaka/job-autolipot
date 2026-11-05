import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../plugins/database.js';
import { AnswerRepository } from '../src/answers/AnswerRepository.js';
import { AnswerService } from '../src/answers/AnswerService.js';
import type { Answer } from '../src/answers/AnswerTypes.js';
import { createAuthFixture, createTestDatabase, mutationHeaders, testAuth } from './auth-fixture.js';
import type { AuthHeaders } from './auth-fixture.js';

describe('Answers: owner-scoped answer bank on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;
  let owner: AuthHeaders;
  let stranger: AuthHeaders;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    server = await buildServer({ databaseUrl: testDatabase.url, logger: false, auth: testAuth });
    auth = await createAuthFixture(server, database);
    owner = auth.userHeaders;
    stranger = auth.adminHeaders;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  beforeEach(async () => {
    await database.answer.deleteMany({});
  });

  const list = (headers: Record<string, string>) => server.inject({ method: 'GET', url: '/api/answers', headers });
  const put = (headers: Record<string, string>, payload: Record<string, unknown>) => server.inject({ method: 'PUT', url: '/api/answers', headers, payload });
  const remove = (headers: Record<string, string>, id: string) => server.inject({ method: 'DELETE', url: `/api/answers/${id}`, headers });

  it('replaces an answer when the same question comes in another wording', async () => {
    const first = await put(owner, { question: 'Years of experience working with TypeScript*', answer: '1' });
    expect(first.statusCode).toBe(200);
    const second = await put(owner, { question: 'How many years of TypeScript experience?', answer: '2' });
    expect(second.statusCode).toBe(200);
    expect(second.json<Answer>().id).toBe(first.json<Answer>().id);

    const answers = (await list(owner)).json<Answer[]>();
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ question: 'How many years of TypeScript experience?', answer: '2', origin: 'manual' });
    expect(answers[0]).not.toHaveProperty('key');
  });

  it('hides and protects other owners\' answers', async () => {
    const mine = (await put(owner, { question: 'Email address', answer: 'owner@example.test' })).json<Answer>();
    await put(stranger, { question: 'Email address', answer: 'stranger@example.test' });

    expect((await list(owner)).json<Answer[]>().map((answer) => answer.answer)).toEqual(['owner@example.test']);
    expect((await list(stranger)).json<Answer[]>().map((answer) => answer.answer)).toEqual(['stranger@example.test']);

    const foreign = await remove(stranger, mine.id);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json<{ error: { code: string } }>().error.code).toBe('ANSWER_NOT_FOUND');
    expect(await database.answer.count({ where: { id: mine.id } })).toBe(1);

    expect((await remove(owner, mine.id)).statusCode).toBe(204);
    expect((await remove(owner, mine.id)).statusCode).toBe(404);
    expect((await list(owner)).json<Answer[]>()).toEqual([]);
  });

  it('requires sign-in', async () => {
    expect((await list({})).statusCode).toBe(401);
    expect((await put(mutationHeaders, { question: 'Email address', answer: 'x' })).statusCode).toBe(401);
    expect((await remove(mutationHeaders, 'any')).statusCode).toBe(401);
  });

  it('rejects a question without meaningful words and malformed bodies', async () => {
    const noise = await put(owner, { question: 'How many do you have?', answer: '1' });
    expect(noise.statusCode).toBe(400);
    expect(noise.json<{ error: { code: string } }>().error.code).toBe('ANSWER_KEY_EMPTY');
    expect((await put(owner, { question: 'Email address' })).statusCode).toBe(400);
    expect((await put(owner, { question: 'Email address', answer: 'x', origin: 'telegram' })).statusCode).toBe(400);
  });

  it('serves other domains through AnswerApi with the origin they give', async () => {
    const api = new AnswerService(new AnswerRepository(database));
    await api.upsert(auth.user.id, 'Do you require visa sponsorship?', 'No', 'telegram');
    await api.upsert(auth.user.id, 'Expected salary / rate', 'base the number\non the posting', 'manual');

    const answers = await api.listForUser(auth.user.id);
    expect(answers.map((answer) => [answer.question, answer.origin])).toEqual([
      ['Do you require visa sponsorship?', 'telegram'], ['Expected salary / rate', 'manual'],
    ]);
    expect(answers[1]!.answer).toBe('base the number\non the posting');
    expect(await api.listForUser(auth.admin.id)).toEqual([]);
  });
});
