import type * as DMMF from '@prisma/dmmf';

export type CrudOperation = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface FieldDefinition {
  readonly name: string;
  readonly type: string;
  readonly kind: 'scalar' | 'enum';
  readonly isRequired: boolean;
  readonly isList: boolean;
  readonly hasDefaultValue: boolean;
  readonly isUpdatedAt: boolean;
  readonly isId: boolean;
  readonly enumValues: readonly string[];
  readonly nativeType: readonly [string, readonly string[]] | null;
}

export interface DomainDefinition {
  readonly model: string;
  readonly name: string;
  readonly domain: string;
  readonly delegate: string;
  readonly route: string;
  readonly operations: readonly CrudOperation[];
  readonly fields: readonly FieldDefinition[];
  readonly readFields: readonly FieldDefinition[];
  readonly createFields: readonly FieldDefinition[];
  readonly updateFields: readonly FieldDefinition[];
  readonly id: FieldDefinition;
}

const operations: readonly CrudOperation[] = ['list', 'get', 'create', 'update', 'delete'];
const scalarTypes = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Decimal', 'BigInt', 'Json', 'Bytes']);
const supportedNativeTypes: Readonly<Record<string, readonly string[]>> = {
  String: ['Text', 'VarChar', 'Char', 'Uuid'],
  Int: ['Integer', 'SmallInt'],
  Float: ['DoublePrecision'],
  Boolean: ['Boolean'],
  BigInt: ['BigInt'],
  Decimal: ['Decimal'],
  DateTime: ['Timestamp', 'Timestamptz'],
  Json: ['Json', 'JsonB'],
  Bytes: ['ByteA'],
};
const unsafeProperties = new Set(['__proto__', 'prototype', 'constructor', 'toJSON']);
const reservedNames = new Set([
  'Prisma', 'PrismaClient', 'ApplicationError', 'FastifyInstance', 'FastifyRequest', 'FastifyReply',
  'Array', 'ReadonlyArray', 'Readonly', 'Promise', 'Date', 'Record', 'Partial', 'Required', 'Pick',
  'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'Awaited', 'Object',
  'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Function', 'Buffer', 'Uint8Array', 'Error',
  'Map', 'Set', 'Math', 'JSON', 'DatabaseTypes', 'JsonValue', 'GeneratedField', 'Context',
]);
const domainKeys = new Set(['model', 'domain', 'name', 'route', 'read', 'create', 'update', 'operations']);

function fail(location: string, message: string): never {
  throw new Error(`CRUD generator: ${location}: ${message}`);
}

function record(value: unknown, location: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(location, 'expected an object');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(location, 'expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(location, `unknown option ${String(key)}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(location, 'expected a nonempty string');
  return value;
}

function strings(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) fail(location, 'expected an array of field names');
  const result = value.map((item: unknown, index: number) => requiredString(item, `${location}[${index}]`));
  const seen = new Set<string>();
  for (const item of result) {
    if (seen.has(item)) fail(location, `duplicate value ${item}`);
    seen.add(item);
  }
  return result;
}

function nativeTypeFor(field: DMMF.Field): FieldDefinition['nativeType'] {
  if (field.nativeType) {
    const [native, arguments_] = field.nativeType;
    // SQL CHAR without a width is CHAR(1); VARCHAR without a width remains unbounded.
    return [native, native === 'Char' && arguments_.length === 0 ? ['1'] : [...arguments_]];
  }
  // PostgreSQL's implicit Prisma Decimal mapping is decimal(65, 30), not an unbounded numeric.
  return field.kind === 'scalar' && field.type === 'Decimal' ? ['Decimal', ['65', '30']] : null;
}

function normalizeField(field: DMMF.Field, datamodel: DMMF.Datamodel): FieldDefinition | undefined {
  if (field.kind !== 'scalar' && field.kind !== 'enum') return undefined;
  if (field.kind === 'scalar' && !scalarTypes.has(field.type)) return undefined;
  const enumDefinition = field.kind === 'enum' ? datamodel.enums.find(candidate => candidate.name === field.type) : undefined;
  if (field.kind === 'enum' && !enumDefinition) return undefined;
  return {
    name: field.name,
    type: field.type,
    kind: field.kind,
    isRequired: field.isRequired,
    isList: field.isList,
    hasDefaultValue: field.hasDefaultValue,
    isUpdatedAt: field.isUpdatedAt ?? false,
    isId: field.isId,
    enumValues: enumDefinition?.values.map(value => value.name) ?? [],
    nativeType: nativeTypeFor(field),
  };
}

function selectedFields(
  names: readonly string[],
  fields: readonly FieldDefinition[],
  model: DMMF.Model,
  location: string,
): FieldDefinition[] {
  return names.map(name => {
    if (unsafeProperties.has(name)) fail(location, `unsafe field name ${name}`);
    const field = fields.find(candidate => candidate.name === name);
    if (field) {
      if (field.type === 'Decimal' && field.nativeType?.[0] === 'Money') {
        fail(location, `${name} uses unsupported PostgreSQL @db.Money; use Decimal with explicit precision and scale`);
      }
      if (field.nativeType) {
        const [native, arguments_] = field.nativeType;
        if (field.kind !== 'scalar' || !supportedNativeTypes[field.type]?.includes(native)) {
          fail(location, `${name} uses unsupported PostgreSQL @db.${native}; exclude it from generated CRUD or implement a custom repository/API`);
        }
        if (field.type === 'DateTime' && arguments_.length > 0 && Number(arguments_[0]) < 3) {
          fail(location, `${name} requires timestamp precision of at least 3; lower precision rounds milliseconds; use a custom repository/API`);
        }
      }
      if (field.type === 'Decimal' && field.nativeType?.[0] === 'Decimal' && field.nativeType[1].length >= 2) {
        const precision = Number(field.nativeType[1][0]);
        const scale = Number(field.nativeType[1][1]);
        if (!Number.isInteger(precision) || !Number.isInteger(scale) || precision <= 0 || scale < 0 || scale > precision) {
          fail(location, `${name} requires Decimal precision > 0 and scale between 0 and precision`);
        }
      }
      return field;
    }
    const schemaField = model.fields.find(candidate => candidate.name === name);
    if (schemaField?.kind === 'object') {
      fail(location, `${name} is a relation; expose scalar foreign keys or a separate domain API`);
    }
    if (schemaField) fail(location, `${name} has unsupported Prisma type ${schemaField.type}`);
    fail(location, `unknown or ignored field ${name} on model ${model.name}`);
  });
}

function normalizeDomain(datamodel: DMMF.Datamodel, value: unknown, index: number): DomainDefinition {
  const location = `domains[${index}]`;
  const config = record(value, location, domainKeys);
  const modelName = requiredString(config.model, `${location}.model`);
  const model = datamodel.models.find(candidate => candidate.name === modelName);
  if (!model) fail(location, `unknown or ignored Prisma model ${modelName}`);
  const delegate = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  if (unsafeProperties.has(delegate)) fail(location, `unsafe Prisma model delegate ${delegate}`);

  const name = config.name === undefined ? modelName : requiredString(config.name, `${location}.name`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || reservedNames.has(name)) {
    fail(location, `unsafe or reserved entity name ${name}; use a singular PascalCase name`);
  }
  const domain = requiredString(config.domain, `${location}.domain`);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(domain) || unsafeProperties.has(domain)) {
    fail(location, `unsafe domain directory ${domain}; use a flat lowercase name`);
  }
  const route = requiredString(config.route, `${location}.route`);
  if (!/^\/(?:[a-z][a-z0-9-]*)(?:\/[a-z][a-z0-9-]*)*$/.test(route)) {
    fail(location, `unsafe route ${route}; use a static absolute path without a trailing slash`);
  }

  const configuredOperations = config.operations === undefined
    ? [...operations]
    : strings(config.operations, `${location}.operations`);
  if (configuredOperations.length === 0) fail(location, 'operations must not be empty');
  const enabledOperations: CrudOperation[] = configuredOperations.map(operation => {
    const known = operations.find(candidate => candidate === operation);
    if (!known) fail(location, `unknown operation ${operation}`);
    return known;
  });

  const fields = model.fields.flatMap(field => {
    const normalized = normalizeField(field, datamodel);
    return normalized ? [normalized] : [];
  });
  const ids = fields.filter(field => field.isId);
  const id = ids[0];
  if (model.primaryKey !== null || ids.length !== 1 || !id || !['String', 'Int'].includes(id.type) || id.isList) {
    fail(location, `${modelName} must have exactly one String or Int @id; compound IDs are not supported`);
  }
  const readFields = selectedFields(strings(config.read, `${location}.read`), fields, model, `${location}.read`);
  const createFields = selectedFields(strings(config.create === undefined ? [] : config.create, `${location}.create`), fields, model, `${location}.create`);
  const updateFields = selectedFields(strings(config.update === undefined ? [] : config.update, `${location}.update`), fields, model, `${location}.update`);
  if (!readFields.some(field => field.name === id.name)) fail(location, `read must include ID field ${id.name}`);

  for (const field of createFields) {
    if (field.isUpdatedAt || (field.isId && field.hasDefaultValue)) {
      fail(`${location}.create`, `${field.name} is generated and must not be writable`);
    }
  }
  for (const field of updateFields) {
    if (field.isUpdatedAt || field.isId) fail(`${location}.update`, `${field.name} must not be writable`);
  }
  if (enabledOperations.includes('update') && updateFields.length === 0) {
    fail(location, 'update requires at least one writable field');
  }
  if (enabledOperations.includes('create')) {
    // Prisma supplies @updatedAt and permits omitted scalar lists, even without @default([]).
    const required = model.fields.filter(field => field.kind !== 'object'
      && field.isRequired && !field.isList && !field.hasDefaultValue && !field.isUpdatedAt);
    for (const field of required) {
      if (!createFields.some(candidate => candidate.name === field.name)) {
        fail(`${location}.create`, `missing required Prisma field ${modelName}.${field.name}; expose it or disable create`);
      }
    }
  }

  return {
    model: modelName,
    name,
    domain,
    delegate,
    route,
    operations: enabledOperations,
    fields,
    readFields,
    createFields,
    updateFields,
    id,
  };
}

/** Validate the complete configuration before the generator writes any files. */
export function normalizeDomains(datamodel: DMMF.Datamodel, config: unknown): DomainDefinition[] {
  const root = record(config, 'configuration', new Set(['domains']));
  if (!Array.isArray(root.domains)) fail('configuration.domains', 'expected an array');
  const domains = root.domains.map((value: unknown, index: number) => normalizeDomain(datamodel, value, index));
  for (const property of ['model', 'name', 'domain', 'delegate', 'route'] as const) {
    const seen = new Set<string>();
    for (const domain of domains) {
      const value = domain[property].toLowerCase();
      if (seen.has(value)) fail('configuration.domains', `duplicate ${property}: ${domain[property]}`);
      seen.add(value);
    }
  }
  return domains;
}
