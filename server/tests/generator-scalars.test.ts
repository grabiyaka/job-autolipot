import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { generateDomains } from '../framework/generator/generate.js';

const execute = promisify(execFile);
const project = process.cwd();
let fixture = '';

const schema = `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
}
datasource db {
  provider = "postgresql"
}
enum SampleState {
  OPEN
  CLOSED @map("closed_state")
  @@map("sample_state")
}
model Sample {
  id               Int          @id @default(autoincrement())
  code             String       @unique @map("sample_code")
  count            Int          @default(0)
  ratio            Float        @default(0)
  enabled          Boolean      @default(false)
  title            String       @default("")
  note             String?
  at               DateTime
  optionalAt       DateTime?
  amount           Decimal      @db.Decimal(24, 8)
  optionalAmount   Decimal?     @db.Decimal(24, 8)
  quantity         BigInt
  optionalQuantity BigInt?
  binary           Bytes
  optionalBinary   Bytes?
  document         Json
  optionalDocument Json?
  state            SampleState  @default(OPEN)
  optionalState    SampleState?
  tags             String[]     @default([])
  checkpoints      DateTime[]   @default([])
  amounts          Decimal[]    @default([]) @db.Decimal(24, 8)
  quantities       BigInt[]     @default([])
  binaries         Bytes[]      @default([])
  states           SampleState[] @default([])
  integers         Int[]        @default([])
  floats           Float[]      @default([])
  switches         Boolean[]    @default([])
  documents        Json[]       @default([])
  secret           String       @default("internal")
  @@map("scalar_samples")
}
model Label {
  id    String @id @default(uuid()) @db.Uuid
  name  String
}
`;

const writable = [
  'code', 'count', 'ratio', 'enabled', 'title', 'note', 'at', 'optionalAt',
  'amount', 'optionalAmount', 'quantity', 'optionalQuantity', 'binary', 'optionalBinary',
  'document', 'optionalDocument', 'state', 'optionalState', 'tags', 'checkpoints',
  'amounts', 'quantities', 'binaries', 'states', 'integers', 'floats', 'switches', 'documents',
];

async function command(file: string, args: string[]): Promise<void> {
  try {
    await execute(file, args, { cwd: fixture, timeout: 60_000, maxBuffer: 2_000_000 });
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      throw new Error(`${error.message}\n${String(error.stdout)}\n${String(error.stderr)}`, { cause: error });
    }
    throw error;
  }
}

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'framework-generator-scalars-'));
  await Promise.all([
    mkdir(path.join(fixture, 'prisma'), { recursive: true }),
    mkdir(path.join(fixture, 'framework/core'), { recursive: true }),
    mkdir(path.join(fixture, 'framework/http'), { recursive: true }),
    symlink(path.join(project, 'node_modules'), path.join(fixture, 'node_modules'), 'dir'),
    writeFile(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' })),
  ]);
  await Promise.all([
    writeFile(path.join(fixture, 'prisma/schema.prisma'), schema),
    writeFile(path.join(fixture, 'prisma/domains.json'), JSON.stringify({
      domains: [
        {
          model: 'Sample', name: 'Sample', domain: 'samples', route: '/api/samples',
          read: ['id', ...writable], create: writable, update: writable,
        },
        {
          model: 'Label', name: 'Label', domain: 'labels', route: '/api/labels',
          read: ['id', 'name'], create: ['name'], update: ['name'],
        },
      ],
    })),
    copyFile(path.join(project, 'framework/core/errors.ts'), path.join(fixture, 'framework/core/errors.ts')),
    copyFile(path.join(project, 'framework/http/error-schema.ts'), path.join(fixture, 'framework/http/error-schema.ts')),
    writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noUnusedLocals: true, noUnusedParameters: true, verbatimModuleSyntax: true,
        skipLibCheck: true, esModuleInterop: true, types: ['node'], outDir: 'dist',
      },
      include: ['src/**/*.ts', 'framework/**/*.ts', 'generated/**/*.ts', 'probe.ts'],
    })),
  ]);
  await generateDomains({ root: fixture });
  // Keep all configured scalar allowlists even when only one operation is
  // enabled. Disabled branches must not leave unused Prisma imports or fields.
  for (const operation of ['list', 'get', 'create', 'update', 'delete'] as const) {
    const name = `Sample${operation.charAt(0).toUpperCase()}${operation.slice(1)}`;
    const variant = path.join(fixture, 'variants', operation);
    const domain = `sample-${operation}`;
    await mkdir(variant, { recursive: true });
    const configuration = path.join(variant, 'domains.json');
    await writeFile(configuration, JSON.stringify({ domains: [{
      model: 'Sample', name, domain: `sample-${operation}`, route: `/api/sample-${operation}`,
      read: ['id', ...writable], create: writable, update: writable, operations: [operation],
    }] }));
    await generateDomains({
      root: variant, schema: path.join(fixture, 'prisma/schema.prisma'), config: configuration,
    });
    await cp(path.join(variant, 'src', domain), path.join(fixture, 'src', domain), { recursive: true });
  }
  await command(process.execPath, [path.join(project, 'node_modules/prisma/build/index.js'), 'generate']);
  await writeFile(path.join(fixture, 'probe.ts'), probe);
  // A real Prisma Client is essential here: stubbing its types would conceal invalid
  // scalar-list conversions, JSON null assignments and delegate select/input types.
  await command(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
}, 90_000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('Generated CRUD scalar contracts and Prisma mapping', () => {
  it.each([
    ['roundtrip', 'preserves exact scalar values, enum/list types and hides unselected fields'],
    ['nullable', 'distinguishes nullable JSON from nonnullable JSON and preserves nested null'],
    ['defaults', 'leaves omitted defaults and nullable fields to Prisma without losing false, zero or empty strings'],
    ['update', 'updates selected scalar fields without accepting unknown or nested writes'],
    ['ids', 'preserves Int and String identifiers across repository operations'],
    ['errors', 'translates duplicate, foreign-key and missing-row failures into domain errors'],
    ['invalid', 'rejects malformed scalar values before persistence'],
    ['http', 'validates and serializes generated scalar schemas without altering JSON values'],
    ['operation-subsets', 'compiles every isolated CRUD operation with strict unused-symbol checks'],
  ])('%s: %s', async (scenario) => {
    await command(process.execPath, [path.join(fixture, 'dist/probe.js'), scenario]);
  });
});

const probe = String.raw`
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Prisma, type PrismaClient, type Sample as SampleRow } from './generated/prisma/client.js';
import { SampleRepository } from './src/samples/SampleRepository.js';
import { SampleService } from './src/samples/SampleService.js';
import { LabelRepository } from './src/labels/LabelRepository.js';
import { LabelService } from './src/labels/LabelService.js';
import { SampleListService } from './src/sample-list/SampleListService.js';
import { SampleGetService } from './src/sample-get/SampleGetService.js';
import { SampleCreateService } from './src/sample-create/SampleCreateService.js';
import { SampleUpdateService } from './src/sample-update/SampleUpdateService.js';
import { SampleDeleteService } from './src/sample-delete/SampleDeleteService.js';
import { registerSampleRoutes } from './src/samples/SampleRoutes.js';
import type { CreateSampleInput, Sample, UpdateSampleInput } from './src/samples/SampleTypes.js';
import { ApplicationError } from './framework/core/errors.js';

const fullInput: CreateSampleInput = {
  code: 'EXAMPLE', count: 0, ratio: 0, enabled: false, title: '', note: '',
  at: '2026-10-08T12:30:00+03:00', optionalAt: '2026-01-02T00:00:00Z',
  amount: '1234567890123456.12345678', optionalAmount: '0.00000001',
  quantity: '9007199254740993', optionalQuantity: '-9223372036854775808',
  binary: 'AAH/', optionalBinary: '',
  document: { nested: [null, false, 0, '', { child: 'value' }] },
  optionalDocument: { present: null }, state: 'CLOSED', optionalState: 'OPEN',
  tags: ['', 'one'], checkpoints: ['2026-10-08T12:30:00+03:00'],
  amounts: ['0', '-1.12345678'], quantities: ['0', '9223372036854775807'],
  binaries: ['', 'AQI='], states: ['OPEN', 'CLOSED'], integers: [0, -1],
  floats: [0, -1.25], switches: [false, true], documents: [{ x: null }, [0, false, null]],
};
const minimalInput: CreateSampleInput = {
  code: 'EXAMPLE', at: '2026-10-08T12:30:00+03:00',
  amount: '1234567890123456.12345678', quantity: '9007199254740993',
  binary: 'AAH/', document: { nested: [null, false, 0, ''] },
};

// These expectations are checked by the real TypeScript compiler, against the
// freshly generated contracts and actual generated Prisma Client.
const checkDate: Sample['at'] = '2026-10-08T00:00:00Z';
const checkNullableJson: CreateSampleInput['optionalDocument'] = null;
const checkJsonResponse: Sample['document'] = null;
// @ts-expect-error Decimal is a lossless wire string, never a JavaScript number.
const wrongAmount: CreateSampleInput['amount'] = 1.5;
// @ts-expect-error BigInt is a decimal string in the public API.
const wrongQuantity: CreateSampleInput['quantity'] = 9007199254740993n;
// @ts-expect-error Date objects do not escape through framework-independent DTOs.
const wrongDate: Sample['at'] = new Date();
// @ts-expect-error The generated enum remains a literal union.
const wrongEnum: CreateSampleInput['state'] = 'UNKNOWN';
// @ts-expect-error Nonnullable JSON cannot be set to ambiguous top-level null.
const wrongJson: CreateSampleInput['document'] = null;
// @ts-expect-error Generated identifiers cannot be updated.
const wrongId: UpdateSampleInput = { id: 2 };
void [checkDate, checkNullableJson, checkJsonResponse, wrongAmount, wrongQuantity, wrongDate, wrongEnum, wrongJson, wrongId];

let row: SampleRow = {
  id: 7, code: 'EXAMPLE', count: 0, ratio: 0, enabled: false, title: '', note: '',
  at: new Date('2026-10-08T09:30:00Z'), optionalAt: new Date('2026-01-02T00:00:00Z'),
  amount: new Prisma.Decimal('1234567890123456.12345678'), optionalAmount: new Prisma.Decimal('0.00000001'),
  quantity: 9007199254740993n, optionalQuantity: -9223372036854775808n,
  binary: new Uint8Array([0, 1, 255]), optionalBinary: new Uint8Array(),
  document: { nested: [null, false, 0, '', { child: 'value' }] },
  optionalDocument: { present: null }, state: 'CLOSED', optionalState: 'OPEN',
  tags: ['', 'one'], checkpoints: [new Date('2026-10-08T09:30:00Z')],
  amounts: [new Prisma.Decimal(0), new Prisma.Decimal('-1.12345678')],
  quantities: [0n, 9223372036854775807n], binaries: [new Uint8Array(), new Uint8Array([1, 2])],
  states: ['OPEN', 'CLOSED'], integers: [0, -1], floats: [0, -1.25], switches: [false, true],
  documents: [{ x: null }, [0, false, null]], secret: 'must never leak',
};
let failure: unknown;
let missing = false;
let callCount = 0;
let createArgs: Prisma.SampleCreateArgs | undefined;
let updateArgs: Prisma.SampleUpdateArgs | undefined;
let getArgs: Prisma.SampleFindUniqueArgs | undefined;
let deleteArgs: Prisma.SampleDeleteArgs | undefined;
function result(): SampleRow {
  callCount += 1;
  if (failure) throw failure;
  return row;
}
// The cast is restricted to this database fake: Prisma's generic delegates
// cannot be structurally implemented by a deliberately small in-memory stub.
const database = { sample: {
  async create(args: Prisma.SampleCreateArgs) { createArgs = args; return result(); },
  async update(args: Prisma.SampleUpdateArgs) { updateArgs = args; return result(); },
  async findUnique(args: Prisma.SampleFindUniqueArgs) { getArgs = args; return missing ? null : result(); },
  async delete(args: Prisma.SampleDeleteArgs) { deleteArgs = args; return result(); },
  async findMany() { return [result()]; },
  async count() { return 1; },
} } as unknown as Pick<PrismaClient, 'sample'>;
const repository = new SampleRepository(database);
const service = new SampleService(repository, () => {});
const context = undefined;

function invalid(error: unknown): boolean {
  assert.ok(error instanceof ApplicationError);
  assert.equal(error.statusCode, 400);
  return true;
}

switch (process.argv[2]) {
  case 'roundtrip': {
    const record = await service.create(fullInput, context);
    assert.deepEqual(record, {
      ...fullInput, id: 7, at: '2026-10-08T09:30:00.000Z',
      optionalAt: '2026-01-02T00:00:00.000Z', checkpoints: ['2026-10-08T09:30:00.000Z'],
    });
    assert.ok(createArgs);
    const data = createArgs.data;
    assert.ok(data.at instanceof Date);
    assert.equal(data.at.toISOString(), '2026-10-08T09:30:00.000Z');
    assert.ok(data.amount instanceof Prisma.Decimal);
    assert.equal(data.amount.toFixed(), '1234567890123456.12345678');
    assert.equal(data.quantity, 9007199254740993n);
    assert.deepEqual(data.binary, Buffer.from([0, 1, 255]));
    assert.equal(data.count, 0);
    assert.equal(data.enabled, false);
    assert.equal(data.title, '');
    assert.deepEqual(data.document, fullInput.document);
    assert.deepEqual(data.optionalDocument, { present: null });
    assert.deepEqual(data.quantities, [0n, 9223372036854775807n]);
    assert.deepEqual(data.checkpoints, [new Date('2026-10-08T09:30:00Z')]);
    assert.deepEqual(data.binaries, [Buffer.alloc(0), Buffer.from([1, 2])]);
    assert.deepEqual(data.documents, [{ x: null }, [0, false, null]]);
    assert.equal(createArgs.select?.secret, undefined);
    assert.equal(Object.hasOwn(record, 'secret'), false);
    assert.equal(JSON.parse(JSON.stringify(record)).quantity, '9007199254740993');
    const page = await service.list({}, context);
    assert.equal(page.total, 1);
    assert.deepEqual(page.items, [record]);
    break;
  }
  case 'nullable': {
    const nulls = {
      note: null, optionalAt: null, optionalAmount: null, optionalQuantity: null,
      optionalBinary: null, optionalDocument: null, optionalState: null,
    };
    row = { ...row, ...nulls, document: null };
    const record = await service.create({ ...fullInput, ...nulls }, context);
    assert.ok(createArgs);
    assert.equal(createArgs.data.optionalDocument, Prisma.DbNull);
    assert.equal(createArgs.data.optionalAt, null);
    assert.equal(createArgs.data.optionalAmount, null);
    assert.equal(createArgs.data.optionalBinary, null);
    assert.equal(createArgs.data.optionalQuantity, null);
    assert.equal(record.document, null);
    for (const name of Object.keys(nulls)) assert.equal(record[name as keyof Sample], null);
    await assert.rejects(service.create({ ...fullInput, document: null } as unknown as CreateSampleInput, context), invalid);
    await assert.rejects(service.create({ ...fullInput, documents: [null] } as unknown as CreateSampleInput, context), invalid);
    break;
  }
  case 'defaults': {
    await service.create(minimalInput, context);
    assert.ok(createArgs);
    assert.deepEqual(Object.keys(createArgs.data).sort(), Object.keys(minimalInput).sort());
    assert.equal(Object.hasOwn(createArgs.data, 'id'), false);
    assert.equal(Object.hasOwn(createArgs.data, 'state'), false);
    assert.equal(Object.hasOwn(createArgs.data, 'optionalDocument'), false);
    await service.update(7, { enabled: false, count: 0, ratio: 0, title: '', tags: [] }, context);
    assert.ok(updateArgs);
    assert.deepEqual(updateArgs.data, { enabled: false, count: 0, ratio: 0, title: '', tags: [] });
    break;
  }
  case 'update': {
    await service.update(7, { quantity: '0', optionalDocument: null, optionalBinary: '', amount: '0' }, context);
    assert.ok(updateArgs);
    assert.deepEqual(updateArgs.where, { id: 7 });
    assert.equal(updateArgs.data.quantity, 0n);
    assert.equal(updateArgs.data.optionalDocument, Prisma.DbNull);
    assert.deepEqual(updateArgs.data.optionalBinary, Buffer.alloc(0));
    const before = callCount;
    for (const input of [{ secret: 'changed' }, { id: 8 }, { owner: { create: { name: 'nested' } } }, { count: { increment: 1 } }, {}]) {
      await assert.rejects(service.update(7, input as unknown as UpdateSampleInput, context), invalid);
    }
    assert.equal(callCount, before);
    // Persistence also projects known fields if called directly with an unsafe value.
    await repository.update(7, { title: '', secret: 'bad', owner: { create: {} } } as UpdateSampleInput);
    assert.deepEqual(updateArgs.data, { title: '' });
    break;
  }
  case 'ids': {
    await service.get(0, context);
    assert.deepEqual(getArgs?.where, { id: 0 });
    await service.delete(-1, context);
    assert.deepEqual(deleteArgs?.where, { id: -1 });
    await assert.rejects(service.get('7' as unknown as number, context), invalid);
    const id = '550e8400-e29b-41d4-a716-446655440000';
    let received: Prisma.LabelFindUniqueArgs | undefined;
    const labels = new LabelRepository({ label: {
      async findUnique(args: Prisma.LabelFindUniqueArgs) { received = args; return { id, name: '' }; },
    } } as unknown as Pick<PrismaClient, 'label'>);
    assert.deepEqual(await labels.get(id), { id, name: '' });
    assert.deepEqual(received?.where, { id });
    const labelService = new LabelService(labels, () => {});
    await assert.rejects(labelService.get('not-a-uuid', context), invalid);
    break;
  }
  case 'errors': {
    for (const [code, status, publicCode] of [
      ['P2002', 409, 'CONFLICT'], ['P2003', 409, 'RELATION_CONFLICT'],
      ['P2025', 404, 'NOT_FOUND'], ['P2000', 400, 'INVALID_INPUT'],
    ] as const) {
      failure = { code };
      await assert.rejects(repository.create(minimalInput), (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.statusCode, status);
        assert.equal(error.code, publicCode);
        return true;
      });
    }
    const unexpected = new Error('connection unavailable');
    failure = unexpected;
    await assert.rejects(repository.get(7), (error: unknown) => error === unexpected);
    failure = undefined;
    missing = true;
    assert.equal(await repository.get(7), null);
    await assert.rejects(service.get(7, context), (error: unknown) => error instanceof ApplicationError && error.statusCode === 404);
    break;
  }
  case 'invalid': {
    const mutations = [
      { count: 1.5 }, { count: 2147483648 }, { ratio: Infinity }, { enabled: 'false' },
      { amount: '1e3' }, { amount: '0.123456789' }, { amount: '10000000000000000' },
      { quantity: '9223372036854775808' }, { quantity: '-9223372036854775809' },
      { quantity: '1.0' }, { binary: '!not-base64' }, { at: '2026-10-08' },
      { at: 'not-a-date' }, { at: '2026-02-30T00:00:00Z' }, { at: '2026-10-08T24:00:00Z' },
      { at: '2026-10-08T09:30:00.1234Z' },
      { state: 'UNKNOWN' }, { states: ['UNKNOWN'] },
      { checkpoints: ['yesterday'] }, { quantities: [1] }, { switches: [0] },
      { document: { bad: undefined } }, { optionalAt: undefined },
    ];
    for (const mutation of mutations) {
      await assert.rejects(service.create({ ...fullInput, ...mutation } as unknown as CreateSampleInput, context), invalid);
    }
    assert.equal(callCount, 0);
    await service.create({ ...fullInput, at: '2026-10-08T09:30:00.123Z' }, context);
    assert.ok(createArgs?.data.at instanceof Date);
    assert.equal(createArgs.data.at.toISOString(), '2026-10-08T09:30:00.123Z');
    break;
  }
  case 'http': {
    const app = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } } });
    app.setErrorHandler((error, request, reply) => {
      const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode : 500;
      return reply.code(status).send({ error: {
        code: error instanceof ApplicationError ? error.code : 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : 'Unexpected failure', requestId: request.id,
      } });
    });
    registerSampleRoutes(app, service, () => undefined);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/samples', payload: fullInput });
      assert.equal(response.statusCode, 201, response.body);
      const body: Sample = response.json();
      assert.deepEqual(body.document, fullInput.document);
      assert.deepEqual(body.documents, fullInput.documents);
      assert.equal(body.amount, '1234567890123456.12345678');
      assert.equal(body.quantity, '9007199254740993');
      assert.equal(body.enabled, false);
      assert.equal(body.binary, 'AAH/');
      assert.equal(Object.hasOwn(body, 'secret'), false);
      row = { ...row, document: null, optionalDocument: null };
      const nullableResponse = await app.inject({ method: 'GET', url: '/api/samples/7' });
      assert.equal(nullableResponse.statusCode, 200, nullableResponse.body);
      assert.equal(nullableResponse.json().document, null);
      assert.equal(nullableResponse.json().optionalDocument, null);
      const millisecondsResponse = await app.inject({
        method: 'POST', url: '/api/samples', payload: { ...fullInput, at: '2026-10-08T09:30:00.123Z' },
      });
      assert.equal(millisecondsResponse.statusCode, 201, millisecondsResponse.body);
      assert.ok(createArgs?.data.at instanceof Date);
      assert.equal(createArgs.data.at.toISOString(), '2026-10-08T09:30:00.123Z');
      for (const invalidInput of [
        { ...fullInput, quantity: '1.5' }, { ...fullInput, document: null }, { ...fullInput, secret: 'bad' },
        { ...fullInput, at: '2026-10-08T09:30:00.1234Z' },
      ]) {
        const rejected = await app.inject({ method: 'POST', url: '/api/samples', payload: invalidInput });
        assert.equal(rejected.statusCode, 400, rejected.body);
      }
    } finally { await app.close(); }
    break;
  }
  case 'operation-subsets': {
    // These services can share a richer typed repository, but expose exactly
    // their configured public operations. No dependency registry is needed.
    const examples = [
      [new SampleListService(repository, () => {}), 'list'],
      [new SampleGetService(repository, () => {}), 'get'],
      [new SampleCreateService(repository, () => {}), 'create'],
      [new SampleUpdateService(repository, () => {}), 'update'],
      [new SampleDeleteService(repository, () => {}), 'delete'],
    ] as const;
    const operations = ['list', 'get', 'create', 'update', 'delete'];
    for (const [limited, enabled] of examples) {
      for (const operation of operations) assert.equal(operation in limited, operation === enabled);
    }
    const deleteOnly = new SampleDeleteService(repository, () => {});
    await deleteOnly.delete(7, context);
    assert.deepEqual(deleteArgs?.where, { id: 7 });
    break;
  }
  default: throw new Error('Unknown scalar test scenario');
}
`;
