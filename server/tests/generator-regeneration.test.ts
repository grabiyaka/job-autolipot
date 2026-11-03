import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDomains } from '../framework/generator/generate.js';

const execute = promisify(execFile);
const projectRoot = resolve('.');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const domainConfig = {
  domains: [{
    model: 'Note', domain: 'notes', route: '/api/notes',
    read: ['id', 'title', 'description', 'createdAt'],
    create: ['title', 'description'], update: ['title', 'description'],
  }],
};

function schema(titleType: 'String' | 'Int') {
  return `generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model Note {
  id String @id @default(uuid())
  title ${titleType}
  description String?
  createdAt DateTime @default(now())
}
`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'framework-generator-regeneration-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'prisma'));
  await mkdir(join(root, 'framework/core'), { recursive: true });
  await mkdir(join(root, 'framework/http'), { recursive: true });
  await cp(join(projectRoot, 'framework/core/errors.ts'), join(root, 'framework/core/errors.ts'));
  await cp(join(projectRoot, 'framework/http/error-schema.ts'), join(root, 'framework/http/error-schema.ts'));
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(root, 'prisma/schema.prisma'), schema('String'));
  await writeFile(join(root, 'prisma/domains.json'), JSON.stringify(domainConfig));
  return root;
}

async function filesUnder(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await filesUnder(path));
    else result[path] = await readFile(path, 'utf8');
  }
  return result;
}

async function checkTypes(root: string, titleType: 'String' | 'Int') {
  const validTitle = titleType === 'String' ? "'A note'" : '123';
  const invalidTitle = titleType === 'String' ? '123' : "'A note'";
  await writeFile(join(root, 'consumer.ts'), `import type { CreateNoteInput, UpdateNoteInput, Note } from './src/notes/NoteTypes.js';
import type { NoteRouteAccess } from './src/notes/NoteRoutes.js';
export const create: CreateNoteInput = { title: ${validTitle} };
export const update: UpdateNoteInput = { title: ${validTitle}, description: null };
export const record: Note = { id: 'example', title: ${validTitle}, description: null, createdAt: '2030-01-01T00:00:00.000Z' };
// @ts-expect-error Prisma's field type must propagate into create input.
export const wrongCreate: CreateNoteInput = { title: ${invalidTitle} };
// @ts-expect-error Prisma's field type must propagate into update input.
export const wrongUpdate: UpdateNoteInput = { title: ${invalidTitle} };
// @ts-expect-error Prisma's field type must propagate into public output.
export const wrongRecord: Note = { id: 'example', title: ${invalidTitle}, description: null, createdAt: '2030-01-01T00:00:00.000Z' };
// @ts-expect-error Generated defaults do not make explicitly excluded IDs writeable.
export const writeId: CreateNoteInput = { title: ${validTitle}, id: 'not-writeable' };
// @ts-expect-error Database-generated timestamps are not part of update input.
export const writeTimestamp: UpdateNoteInput = { createdAt: '2030-01-01T00:00:00.000Z' };
export const access: NoteRouteAccess = {
  list: (_request, _reply, done) => done(),
  get: [(_request, _reply, done) => done(), async (_request, _reply) => {}],
  create: async (_request, _reply) => {},
};
// @ts-expect-error Only enabled CRUD operations are valid middleware keys.
export const invalidAccess: NoteRouteAccess = { archive: async () => {} };
`);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      exactOptionalPropertyTypes: true, skipLibCheck: true, noEmit: true,
    },
    files: ['consumer.ts'],
  }));
  await execute(process.execPath, [join(projectRoot, 'node_modules/typescript/bin/tsc'), '--project', join(root, 'tsconfig.json')], {
    cwd: root, timeout: 30_000,
  });
}

async function probeHttp(root: string): Promise<{ stringStatus: number; numberStatus: number; numberBody: unknown }> {
  const script = `import Fastify from 'fastify';
import { registerNoteRoutes } from './src/notes/NoteRoutes.js';
const server = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
server.setErrorHandler((error, request, reply) => reply.code(error.statusCode ?? 500).send({
  error: { code: 'INVALID_REQUEST', message: error.message, requestId: request.id },
}));
const record = input => ({ id: 'example', description: null, createdAt: '2030-01-01T00:00:00.000Z', ...input });
const api = {
  list: async () => ({ items: [], total: 0, page: 1, limit: 20 }),
  get: async () => record({ title: 'unused' }),
  create: async input => record(input),
  update: async (_id, input) => record(input),
  delete: async () => {},
};
registerNoteRoutes(server, api, () => undefined);
try {
  const stringResponse = await server.inject({ method: 'POST', url: '/api/notes', payload: { title: 'old value' } });
  const numberResponse = await server.inject({ method: 'POST', url: '/api/notes', payload: { title: 123 } });
  console.log(JSON.stringify({ stringStatus: stringResponse.statusCode, numberStatus: numberResponse.statusCode, numberBody: numberResponse.json() }));
} finally { await server.close(); }
`;
  await writeFile(join(root, 'probe.mjs'), script);
  const result = await execute(process.execPath, ['--import', 'tsx', 'probe.mjs'], { cwd: root, timeout: 30_000 });
  return JSON.parse(result.stdout.trim());
}

async function probeRouteAccess(root: string): Promise<{ statuses: number[]; events: string[] }> {
  const script = `import Fastify from 'fastify';
import { registerNoteCrudRoutes } from './src/notes/NoteRoutes.js';
const server = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
server.setErrorHandler((error, request, reply) => reply.code(error.statusCode ?? 500).send({
  error: { code: 'ACCESS_DENIED', message: error.message, requestId: request.id },
}));
const events = [];
const record = { id: 'example', title: 'Example', description: null, createdAt: '2030-01-01T00:00:00.000Z' };
const api = {
  list: async () => { events.push('api:list'); return { items: [record], total: 1, page: 1, limit: 20 }; },
  get: async () => { events.push('api:get'); return record; },
  create: async () => { events.push('api:create'); return record; },
  update: async () => { events.push('api:update'); return record; },
  delete: async () => { events.push('api:delete'); },
};
registerNoteCrudRoutes(server, api, () => { events.push('context'); return undefined; }, {
  list: (_request, _reply, done) => { events.push('list:callback'); done(); },
  get: [
    (_request, _reply, done) => { events.push('get:callback'); done(); },
    async () => { events.push('get:async'); },
  ],
  create: async (request, reply) => {
    events.push('create:denied');
    return reply.code(403).send({ error: { code: 'ACCESS_DENIED', message: 'Denied', requestId: request.id } });
  },
  update: async () => {
    events.push('update:denied');
    throw Object.assign(new Error('Denied'), { statusCode: 403 });
  },
});
try {
  const requests = [
    { method: 'GET', url: '/api/notes' },
    { method: 'GET', url: '/api/notes/example' },
    { method: 'POST', url: '/api/notes', payload: { title: 'Denied' } },
    { method: 'PATCH', url: '/api/notes/example', payload: { title: 'Denied' } },
    { method: 'DELETE', url: '/api/notes/example' },
  ];
  const statuses = [];
  for (const request of requests) statuses.push((await server.inject(request)).statusCode);
  console.log(JSON.stringify({ statuses, events }));
} finally { await server.close(); }
`;
  await writeFile(join(root, 'probe-access.mjs'), script);
  const result = await execute(process.execPath, ['--import', 'tsx', 'probe-access.mjs'], { cwd: root, timeout: 30_000 });
  return JSON.parse(result.stdout.trim());
}

describe('Domain generator: repeated generation from Prisma', () => {
  it('runs per-operation callback and async middleware before context, skipping denied handlers', async () => {
    const root = await fixture();
    await generateDomains({ root });

    expect(await probeRouteAccess(root)).toEqual({
      statuses: [200, 200, 403, 403, 204],
      events: [
        'list:callback', 'context', 'api:list',
        'get:callback', 'get:async', 'context', 'api:get',
        'create:denied', 'update:denied',
        'context', 'api:delete',
      ],
    });
  }, 30_000);

  it('updates route validation and public TypeScript types together when one Prisma field changes', async () => {
    const root = await fixture();
    const first = await generateDomains({ root });
    expect(first.created).toHaveLength(6);
    expect((await readdir(join(root, 'src/notes'))).sort()).toEqual([
      'NoteContracts.ts', 'NoteController.ts', 'NoteRepository.ts', 'NoteRoutes.ts', 'NoteService.ts', 'NoteTypes.ts',
    ]);

    await checkTypes(root, 'String');
    expect(await probeHttp(root)).toMatchObject({ stringStatus: 201, numberStatus: 400 });
    const oldTypes = await readFile(join(root, 'src/notes/NoteTypes.ts'), 'utf8');
    const oldRoutes = await readFile(join(root, 'src/notes/NoteRoutes.ts'), 'utf8');

    // A Prisma-only field type change: the field policy is intentionally left untouched.
    await writeFile(join(root, 'prisma/schema.prisma'), schema('Int'));
    await generateDomains({ root });
    expect(await readFile(join(root, 'src/notes/NoteTypes.ts'), 'utf8')).not.toBe(oldTypes);
    expect(await readFile(join(root, 'src/notes/NoteRoutes.ts'), 'utf8')).not.toBe(oldRoutes);
    await checkTypes(root, 'Int');
    expect(await probeHttp(root)).toMatchObject({ stringStatus: 400, numberStatus: 201, numberBody: { title: 123 } });
  }, 60_000);

  it('preserves hand-written extensions, leaves clean output unchanged and checks staleness without writing', async () => {
    const root = await fixture();
    await generateDomains({ root });
    const servicePath = join(root, 'src/notes/NoteService.ts');
    const extension = '\n// Application-owned extension outside the generated region.\nexport const manualBusinessPolicy = "must survive regeneration";\n';
    await writeFile(servicePath, (await readFile(servicePath, 'utf8')) + extension);
    const customPath = join(root, 'src/notes/NoteRules.ts');
    await writeFile(customPath, 'export const requireMeaningfulTitle = (title: string) => title.trim().length > 0;\n');

    const before = await filesUnder(join(root, 'src'));
    const repeated = await generateDomains({ root });
    expect(repeated.created).toHaveLength(0);
    expect(repeated.updated).toHaveLength(0);
    expect(await filesUnder(join(root, 'src'))).toEqual(before);
    const clean = await generateDomains({ root, check: true });
    expect(clean.stale).toHaveLength(0);

    await writeFile(join(root, 'prisma/schema.prisma'), schema('Int'));
    const stale = await generateDomains({ root, check: true });
    expect(stale.stale.length).toBeGreaterThan(0);
    expect(await filesUnder(join(root, 'src'))).toEqual(before);

    await generateDomains({ root });
    expect((await readFile(servicePath, 'utf8')).endsWith(extension)).toBe(true);
    expect(await readFile(customPath, 'utf8')).toBe(before[customPath]);
    expect((await generateDomains({ root, check: true })).stale).toHaveLength(0);
  }, 30_000);

  it('reports orphaned generated domains rather than silently keeping routes after config removal', async () => {
    const root = await fixture();
    await generateDomains({ root });
    const before = await filesUnder(join(root, 'src'));
    await writeFile(join(root, 'prisma/domains.json'), JSON.stringify({ domains: [] }));

    await expect(generateDomains({ root })).rejects.toThrow(/no matching domain configuration/);
    await expect(generateDomains({ root, check: true })).rejects.toThrow(/no matching domain configuration/);
    expect(await filesUnder(join(root, 'src'))).toEqual(before);
  });

});
