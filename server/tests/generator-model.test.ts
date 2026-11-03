import { beforeAll, describe, expect, it } from 'vitest';
import internals from '@prisma/internals';
import type * as DMMF from '@prisma/dmmf';
import { normalizeDomains } from '../framework/generator/model.js';

const schema = `
datasource db {
  provider = "postgresql"
}

enum TaskState {
  DRAFT
  ACTIVE @map("active")
}

model Task {
  id String @id @default(cuid())
  title String @db.VarChar(120)
  details String?
  amount Decimal @default(0) @db.Decimal(16, 4)
  implicitAmount Decimal @default(0)
  money Decimal? @db.Money
  counter BigInt @default(0)
  ratio Float @default(0)
  enabled Boolean @default(true)
  labels String[]
  state TaskState @default(DRAFT)
  states TaskState[] @default([])
  metadata Json?
  attachment Bytes?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  ownerId String?
  owner Owner? @relation(fields: [ownerId], references: [id])
  internal String? @ignore
  point Unsupported("point")?
}

model Owner {
  id String @id @default(cuid())
  title String
  tasks Task[]
}

model Manual {
  id Int @id
  title String
}

model Compound {
  tenant Int
  serial Int
  @@id([tenant, serial])
}

model BigKey {
  id BigInt @id @default(autoincrement())
  title String
}
`;

let datamodel: DMMF.Datamodel;

beforeAll(async () => {
  datamodel = (await internals.getDMMF({ datamodel: schema })).datamodel;
});

function config(overrides: Record<string, unknown> = {}) {
  return {
    model: 'Task',
    domain: 'tasks',
    route: '/api/tasks',
    read: ['id', 'title', 'details', 'amount', 'state'],
    create: ['title', 'details', 'state'],
    update: ['title', 'details', 'state'],
    ...overrides,
  };
}

function normalize(overrides: Record<string, unknown> = {}) {
  return normalizeDomains(datamodel, { domains: [config(overrides)] });
}

describe('Prisma CRUD model metadata', () => {
  it('uses real Prisma metadata without repeating field types in the domain configuration', () => {
    const [domain] = normalize();
    expect(domain).toMatchObject({ model: 'Task', name: 'Task', domain: 'tasks', delegate: 'task', route: '/api/tasks' });
    expect(domain?.operations).toEqual(['list', 'get', 'create', 'update', 'delete']);
    expect(domain?.id).toMatchObject({ name: 'id', type: 'String', isId: true, hasDefaultValue: true });
    expect(domain?.readFields.map(field => field.name)).toEqual(['id', 'title', 'details', 'amount', 'state']);
    expect(domain?.readFields.find(field => field.name === 'title')).toMatchObject({
      isRequired: true, hasDefaultValue: false, nativeType: ['VarChar', ['120']],
    });
    expect(domain?.readFields.find(field => field.name === 'details')).toMatchObject({ isRequired: false });
    expect(domain?.readFields.find(field => field.name === 'amount')).toMatchObject({
      type: 'Decimal', hasDefaultValue: true, nativeType: ['Decimal', ['16', '4']],
    });
    expect(domain?.readFields.find(field => field.name === 'state')).toMatchObject({
      kind: 'enum', enumValues: ['DRAFT', 'ACTIVE'], hasDefaultValue: true,
    });
  });

  it('supports all scalar families, enum lists, nullable values, defaulted fields and scalar foreign keys', () => {
    const fieldNames = ['id', 'title', 'details', 'amount', 'counter', 'ratio', 'enabled', 'labels', 'state',
      'states', 'metadata', 'attachment', 'createdAt', 'updatedAt', 'ownerId'];
    const [domain] = normalize({ read: fieldNames, create: ['title', 'ownerId'], update: ['ownerId'] });
    expect(domain?.readFields.map(field => field.name)).toEqual(fieldNames);
    expect(domain?.fields.find(field => field.name === 'labels')).toMatchObject({ isList: true, type: 'String' });
    expect(domain?.fields.find(field => field.name === 'states')).toMatchObject({ isList: true, enumValues: ['DRAFT', 'ACTIVE'] });
    expect(domain?.fields.find(field => field.name === 'updatedAt')).toMatchObject({ isUpdatedAt: true, hasDefaultValue: false });
    expect(domain?.createFields.map(field => field.name)).toEqual(['title', 'ownerId']);
  });

  it('normalizes implicit PostgreSQL Decimal bounds for route and service validation', () => {
    const [domain] = normalize({ read: ['id', 'implicitAmount'], create: ['title', 'implicitAmount'], update: ['implicitAmount'] });
    for (const field of [domain?.readFields[1], domain?.createFields[1], domain?.updateFields[0]]) {
      expect(field).toMatchObject({ name: 'implicitAmount', type: 'Decimal', nativeType: ['Decimal', ['65', '30']] });
    }
  });

  it.each(['read', 'create', 'update'])('rejects unsupported native Money exposure through %s', operation => {
    const fields = operation === 'read' ? ['id', 'money'] : operation === 'create' ? ['title', 'money'] : ['money'];
    expect(() => normalize({ [operation]: fields })).toThrow(/unsupported PostgreSQL @db.Money/);
  });

  it.each([
    ['String', '@db.Text'], ['String', '@db.VarChar(80)'], ['String', '@db.VarChar'],
    ['String', '@db.Char(8)'], ['String', '@db.Char'], ['String', '@db.Uuid'],
    ['Int', '@db.Integer'], ['Int', '@db.SmallInt'], ['Float', '@db.DoublePrecision'],
    ['Boolean', '@db.Boolean'], ['BigInt', '@db.BigInt'], ['Decimal', '@db.Decimal(16, 4)'],
    ['Decimal', '@db.Decimal'], ['DateTime', '@db.Timestamp'], ['DateTime', '@db.Timestamp(3)'],
    ['DateTime', '@db.Timestamptz(6)'], ['Json', '@db.Json'], ['Json', '@db.JsonB'], ['Bytes', '@db.ByteA'],
  ])('accepts explicitly supported PostgreSQL native mapping %s %s', async (type, native) => {
    const nativeModel = (await internals.getDMMF({
      datamodel: `datasource db {\n provider = "postgresql"\n}\nmodel Native {\n id Int @id @default(autoincrement())\n value ${type}? ${native}\n}`,
    })).datamodel;
    const [domain] = normalizeDomains(nativeModel, { domains: [{
      model: 'Native', domain: 'natives', route: '/api/natives', read: ['id', 'value'], create: ['value'], update: ['value'],
    }] });
    expect(domain?.readFields[1]?.type).toBe(type);
    if (native === '@db.Char') expect(domain?.readFields[1]?.nativeType).toEqual(['Char', ['1']]);
    if (native === '@db.VarChar') expect(domain?.readFields[1]?.nativeType).toEqual(['VarChar', []]);
    if (native === '@db.Decimal') expect(domain?.readFields[1]?.nativeType).toEqual(['Decimal', []]);
  });

  it.each([
    ['DateTime', '@db.Date'], ['DateTime', '@db.Time'], ['DateTime', '@db.Timetz'],
    ['Int', '@db.Oid'], ['String', '@db.Inet'], ['Float', '@db.Real'],
    ['DateTime', '@db.Timestamp(0)'], ['DateTime', '@db.Timestamp(2)'], ['DateTime', '@db.Timestamptz(1)'],
  ])('rejects unsupported PostgreSQL native mapping %s %s only when exposed', async (type, native) => {
    const nativeModel = (await internals.getDMMF({
      datamodel: `datasource db {\n provider = "postgresql"\n}\nmodel Native {\n id Int @id @default(autoincrement())\n value ${type}? ${native}\n}`,
    })).datamodel;
    const nativeConfig = { model: 'Native', domain: 'natives', route: '/api/natives', read: ['id', 'value'], operations: ['get'] };
    expect(() => normalizeDomains(nativeModel, { domains: [nativeConfig] })).toThrow(/unsupported PostgreSQL|precision of at least 3/);
    expect(normalizeDomains(nativeModel, { domains: [{ ...nativeConfig, read: ['id'] }] })[0]?.readFields).toHaveLength(1);
  });

  it('allows manually assigned IDs on create, but not generated IDs or changes to existing IDs', () => {
    expect(normalize({ model: 'Manual', name: 'Manual', read: ['id', 'title'], create: ['id', 'title'], update: ['title'] })[0]?.id.type).toBe('Int');
    expect(() => normalize({ create: ['id', 'title'] })).toThrow(/id is generated/);
    expect(() => normalize({ update: ['id'] })).toThrow(/id must not be writable/);
    expect(() => normalize({ model: 'Manual', name: 'Manual', read: ['id', 'title'], create: ['title'], update: ['title'] })).toThrow(/missing required Prisma field Manual.id/);
  });

  it('permits a read-only domain to omit write configuration and required create fields', () => {
    const [domain] = normalizeDomains(datamodel, {
      domains: [{ model: 'Task', domain: 'tasks', route: '/api/tasks', read: ['id'], operations: ['list', 'get'] }],
    });
    expect(domain?.createFields).toEqual([]);
    expect(domain?.updateFields).toEqual([]);
    expect(normalizeDomains(datamodel, { domains: [] })).toEqual([]);
  });

  it('does not expose fields newly added to Prisma unless explicitly selected', async () => {
    const changed = (await internals.getDMMF({ datamodel: schema.replace('  details String?', '  details String?\n  passwordHash String?') })).datamodel;
    const [domain] = normalizeDomains(changed, { domains: [config()] });
    expect(domain?.fields.some(field => field.name === 'passwordHash')).toBe(true);
    expect(domain?.readFields.some(field => field.name === 'passwordHash')).toBe(false);
    expect(domain?.createFields.some(field => field.name === 'passwordHash')).toBe(false);
    expect(domain?.updateFields.some(field => field.name === 'passwordHash')).toBe(false);
  });

  it('detects schema drift when create cannot populate a new required field', async () => {
    const changed = (await internals.getDMMF({ datamodel: schema.replace('  details String?', '  details String?\n  requiredCode String') })).datamodel;
    expect(() => normalizeDomains(changed, { domains: [config()] })).toThrow(/missing required Prisma field Task.requiredCode/);
  });

  it.each([
    [{ read: ['id', 'owner'] }, /owner is a relation/],
    [{ create: ['title', 'owner'] }, /owner is a relation/],
    [{ read: ['id', 'missing'] }, /unknown or ignored field missing/],
    [{ read: ['id', 'internal'] }, /unknown or ignored field internal/],
    [{ read: ['id', 'point'] }, /unsupported Prisma type point|unknown or ignored field point/],
    [{ create: ['details'] }, /missing required Prisma field Task.title/],
    [{ read: ['title'] }, /read must include ID field id/],
    [{ read: ['id', 'id'] }, /duplicate value id/],
    [{ update: [] }, /update requires at least one writable field/],
    [{ create: ['title', 'updatedAt'] }, /updatedAt is generated/],
    [{ update: ['updatedAt'] }, /updatedAt must not be writable/],
    [{ model: 'Unknown' }, /unknown or ignored Prisma model Unknown/],
    [{ model: 'Compound' }, /compound IDs are not supported/],
    [{ model: 'BigKey' }, /String or Int @id/],
    [{ operations: [] }, /operations must not be empty/],
    [{ operations: ['get', 'get'] }, /duplicate value get/],
    [{ operations: ['upsert'] }, /unknown operation upsert/],
    [{ create: null }, /expected an array/],
    [{ read: 'id' }, /expected an array/],
    [{ read: [1] }, /expected a nonempty string/],
    [{ creat: ['title'] }, /unknown option creat/],
  ])('rejects invalid schema/config selection %j', (override, expected) => {
    expect(() => normalize(override)).toThrow(expected);
  });

  it.each(['../tasks', 'tasks/users', 'Tasks', 'tasks.ts', 'constructor', '__proto__'])('rejects unsafe domain directory %s', domain => {
    expect(() => normalize({ domain })).toThrow(/unsafe domain directory/);
  });

  it.each(['task', '../Task', 'Task-Name', 'Prisma', 'Readonly', 'Promise', 'ApplicationError', 'JsonValue', 'GeneratedField', 'Context'])('rejects unsafe generated symbol %s', name => {
    expect(() => normalize({ name })).toThrow(/unsafe or reserved entity name/);
  });

  it.each(['/api/tasks/', '/api/:tasks', '/api/*', '/api/../tasks', '/api/tasks?x=1', 'api/tasks', '/api/%2ftasks'])('rejects unsafe route %s', route => {
    expect(() => normalize({ route })).toThrow(/unsafe route/);
  });

  it.each(['__proto__', 'prototype', 'constructor', 'toJSON'])('rejects prototype and serialization field hazards %s', field => {
    expect(() => normalize({ read: ['id', field] })).toThrow(/unsafe field name/);
  });

  it('rejects unknown root options and malformed JSON structure', () => {
    expect(() => normalizeDomains(datamodel, { domains: [], extra: true })).toThrow(/unknown option extra/);
    expect(() => normalizeDomains(datamodel, { domains: 'tasks' })).toThrow(/expected an array/);
    expect(() => normalizeDomains(datamodel, null)).toThrow(/expected an object/);
    expect(() => normalizeDomains(datamodel, { domains: [null] })).toThrow(/expected an object/);
    expect(() => normalizeDomains(datamodel, JSON.parse('{"domains":[],"__proto__":{}}') as unknown)).toThrow(/unknown option __proto__/);
  });

  it('rejects duplicate models, directories, symbols, delegates and routes before rendering', () => {
    expect(() => normalizeDomains(datamodel, { domains: [config(), config()] })).toThrow(/duplicate model/);
    const owner = config({ model: 'Owner', name: 'Owner', domain: 'owners', route: '/api/owners', read: ['id', 'title'], create: ['title'], update: ['title'] });
    const duplicates = { name: 'Task', domain: 'tasks', route: '/api/tasks' };
    for (const property of ['name', 'domain', 'route'] as const) {
      expect(() => normalizeDomains(datamodel, { domains: [config(), { ...owner, [property]: duplicates[property] }] })).toThrow(new RegExp(`duplicate ${property}`));
    }
  });
});
