import type { CrudOperation, DomainDefinition, FieldDefinition } from './model.js';
import { fieldSchema, fieldType, inputValue, outputValue } from './scalars.js';

export type GeneratedFile = Readonly<{ path: string; generated: string; extension: string }>;

const quote = (value: string): string => JSON.stringify(value);
const literal = (value: unknown): string => JSON.stringify(value, null, 2);
const requiredForCreate = (field: FieldDefinition): boolean => field.isRequired && !field.hasDefaultValue && !field.isUpdatedAt && !field.isList;
const enabled = (domain: DomainDefinition, operation: CrudOperation): boolean => domain.operations.includes(operation);
const identifierType = (domain: DomainDefinition): string => fieldType(domain.id, 'input');

function properties(fields: readonly FieldDefinition[], mode: 'record' | 'create' | 'update'): string {
  return fields.map((field) => {
    const optional = mode === 'update' || (mode === 'create' && !requiredForCreate(field));
    return `  ${quote(field.name)}${optional ? '?' : ''}: ${fieldType(field, mode === 'record' ? 'output' : 'input')};`;
  }).join('\n');
}

function signatures(domain: DomainDefinition, context: boolean): string[] {
  const name = domain.name;
  const withContext = (arguments_: string) => context ? `${arguments_}, context: Context` : arguments_;
  return domain.operations.map((operation) => {
    switch (operation) {
      case 'list': return `list(${withContext(`query: ${name}ListQuery`)}): Promise<${name}Page>;`;
      case 'get': return `get(${withContext(`id: ${identifierType(domain)}`)}): Promise<${name}${context ? '' : ' | null'}>;`;
      case 'create': return `create(${withContext(`input: Create${name}Input`)}): Promise<${name}>;`;
      case 'update': return `update(${withContext(`id: ${identifierType(domain)}, input: Update${name}Input`)}): Promise<${name}>;`;
      case 'delete': return `delete(${withContext(`id: ${identifierType(domain)}`)}): Promise<void>;`;
    }
  });
}

function contractImports(domain: DomainDefinition): string[] {
  const imports: string[] = [];
  if (domain.operations.some((operation) => operation === 'get' || operation === 'create' || operation === 'update')) imports.push(domain.name);
  if (enabled(domain, 'list')) imports.push(`${domain.name}ListQuery`, `${domain.name}Page`);
  if (enabled(domain, 'create')) imports.push(`Create${domain.name}Input`);
  if (enabled(domain, 'update')) imports.push(`Update${domain.name}Input`);
  return imports;
}

function renderTypes(domain: DomainDefinition): string {
  const name = domain.name;
  const json = [...domain.readFields, ...domain.createFields, ...domain.updateFields].some((field) => field.type === 'Json');
  return `${json ? 'export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\n\n' : ''}export type ${name} = Readonly<{\n${properties(domain.readFields, 'record')}\n}>;

export type Create${name}Input = Readonly<{\n${properties(domain.createFields, 'create')}\n}>;
export type Update${name}Input = Readonly<{\n${properties(domain.updateFields, 'update')}\n}>;
export type ${name}ListQuery = Readonly<{ page?: number; limit?: number }>;
export type ${name}Page = Readonly<{ items: ${name}[]; total: number; page: number; limit: number }>;
export type ${name}Operation = ${domain.operations.map(quote).join(' | ')};
export type ${name}Authorization<Context> = (operation: ${name}Operation, context: Context) => void | Promise<void>;

export interface ${name}CrudApi<Context> {
${signatures(domain, true).map((signature) => `  ${signature}`).join('\n')}
}
`;
}

function renderContracts(domain: DomainDefinition): string {
  const imports = contractImports(domain);
  return `${imports.length ? `import type { ${imports.join(', ')} } from './${domain.name}Types.js';\n\n` : ''}export interface ${domain.name}RepositoryContract {
${signatures(domain, false).map((signature) => `  ${signature}`).join('\n')}
}
`;
}

function renderRepository(domain: DomainDefinition): string {
  const { name, model, delegate, id } = domain;
  const needsRecord = domain.operations.some((operation) => operation !== 'delete');
  const selected = Object.fromEntries(domain.readFields.map((field) => [field.name, true]));
  const imports = contractImports(domain);
  if (needsRecord && !imports.includes(name)) imports.unshift(name);
  const readsJson = needsRecord && domain.readFields.some((field) => field.type === 'Json');
  if (readsJson) imports.push('JsonValue');
  const writeFields = [
    ...(enabled(domain, 'create') ? domain.createFields : []),
    ...(enabled(domain, 'update') ? domain.updateFields : []),
  ];
  const needPrismaValue = writeFields.some((field) => field.type === 'Decimal' || (field.type === 'Json' && !field.isRequired));
  const prismaImport = needsRecord || enabled(domain, 'create') || enabled(domain, 'update');
  const methods: string[] = [];
  if (enabled(domain, 'list')) methods.push(`  async list(query: ${name}ListQuery): Promise<${name}Page> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [records, total] = await databaseOperation(() => Promise.all([
      this.database.${delegate}.findMany({ select: recordSelection, orderBy: { ${quote(id.name)}: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.database.${delegate}.count(),
    ]));
    return { items: records.map(recordFromDatabase), total, page, limit };
  }`);
  if (enabled(domain, 'get')) methods.push(`  async get(id: ${identifierType(domain)}): Promise<${name} | null> {
    const record = await databaseOperation(() => this.database.${delegate}.findUnique({ where: { ${quote(id.name)}: id }, select: recordSelection }));
    return record === null ? null : recordFromDatabase(record);
  }`);
  if (enabled(domain, 'create')) methods.push(`  async create(${domain.createFields.length ? 'input' : '_input'}: Create${name}Input): Promise<${name}> {
    const data: Prisma.${model}UncheckedCreateInput = {
${domain.createFields.map((field) => {
    const expression = `input[${quote(field.name)}]`;
    return requiredForCreate(field)
      ? `      ${quote(field.name)}: ${inputValue(field, expression)},`
      : `      ...(${expression} !== undefined ? { ${quote(field.name)}: ${inputValue(field, expression)} } : {}),`;
  }).join('\n')}
    };
    const record = await databaseOperation(() => this.database.${delegate}.create({ data, select: recordSelection }));
    return recordFromDatabase(record);
  }`);
  if (enabled(domain, 'update')) methods.push(`  async update(id: ${identifierType(domain)}, input: Update${name}Input): Promise<${name}> {
    const data: Prisma.${model}UncheckedUpdateInput = {
${domain.updateFields.map((field) => {
    const expression = `input[${quote(field.name)}]`;
    return `      ...(${expression} !== undefined ? { ${quote(field.name)}: ${inputValue(field, expression)} } : {}),`;
  }).join('\n')}
    };
    const record = await databaseOperation(() => this.database.${delegate}.update({ where: { ${quote(id.name)}: id }, data, select: recordSelection }));
    return recordFromDatabase(record);
  }`);
  if (enabled(domain, 'delete')) methods.push(`  async delete(id: ${identifierType(domain)}): Promise<void> {
    await databaseOperation(() => this.database.${delegate}.delete({ where: { ${quote(id.name)}: id } }));
  }`);

  return `import ${needPrismaValue ? '{ Prisma, type PrismaClient }' : `type { PrismaClient${prismaImport ? ', Prisma' : ''} }`} from '../../generated/prisma/client.js';
import { ApplicationError } from '../../framework/core/errors.js';
${imports.length ? `import type { ${imports.join(', ')} } from './${name}Types.js';\n` : ''}import type { ${name}RepositoryContract } from './${name}Contracts.js';

${readsJson ? `function jsonFromDatabase(value: Prisma.JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(jsonFromDatabase);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (entry === undefined) throw new ApplicationError('INVALID_DATABASE_DATA', 'Stored JSON contains an undefined value.', 500);
      return [key, jsonFromDatabase(entry)];
    }));
  }
  return value;
}

` : ''}${needsRecord ? `const recordSelection = ${literal(selected)} satisfies Prisma.${model}Select;

function recordFromDatabase(record: Prisma.${model}GetPayload<{ select: typeof recordSelection }>): ${name} {
  return {
${domain.readFields.map((field) => `    ${quote(field.name)}: ${outputValue(field, `record[${quote(field.name)}]`)},`).join('\n')}
  };
}

` : ''}async function databaseOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      if (error.code === 'P2025') throw new ApplicationError('NOT_FOUND', '${name} does not exist.', 404);
      if (error.code === 'P2002') throw new ApplicationError('CONFLICT', 'A unique field is already in use.', 409);
      if (error.code === 'P2003') throw new ApplicationError('RELATION_CONFLICT', 'The operation conflicts with a related record.', 409);
      if (error.code === 'P2000' || error.code === 'P2020' || error.code === 'P2006' || error.code === 'P2007') {
        throw new ApplicationError('INVALID_INPUT', 'A field is outside its database constraints.', 400);
      }
    }
    throw error;
  }
}

export class Generated${name}Repository implements ${name}RepositoryContract {
  constructor(protected readonly database: Pick<PrismaClient, ${quote(delegate)}>) {}

${methods.join('\n\n')}
}
`;
}

function descriptor(field: FieldDefinition): Record<string, unknown> {
  const result: Record<string, unknown> = { type: field.type, required: field.isRequired, list: field.isList, id: field.isId };
  if (field.kind === 'enum') result.enumValues = field.enumValues;
  if (field.nativeType) {
    result.nativeType = field.nativeType[0];
    if (['VarChar', 'Char'].includes(field.nativeType[0]) && field.nativeType[1][0] !== undefined) result.maxLength = Number(field.nativeType[1][0]);
    if (field.nativeType[0] === 'Decimal' && field.nativeType[1].length >= 2) {
      result.precision = Number(field.nativeType[1][0]);
      result.scale = Number(field.nativeType[1][1]);
    }
  }
  return result;
}

const serviceInputValidation = `type GeneratedField = Readonly<{
  type: string; required: boolean; list: boolean; id?: boolean; enumValues?: readonly string[];
  nativeType?: string; maxLength?: number; precision?: number; scale?: number;
}>;

function invalidField(field: string): never {
  throw new ApplicationError('INVALID_INPUT', 'Invalid field: ' + field, 400);
}

function isJson(value: unknown, ancestors: Set<object> = new Set()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => isJson(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function isDateTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const date = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d{1,3})?(?:Z|([+-])(\\d{2}):(\\d{2}))$/.exec(value);
  if (!date || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return year > 0 && days !== undefined && day >= 1 && day <= days
    && Number(date[4]) < 24 && Number(date[5]) < 60 && Number(date[6]) < 60
    && (date[7] === undefined || (Number(date[8]) < 24 && Number(date[9]) < 60));
}

function validateField(value: unknown, field: GeneratedField, name: string): void {
  if (value === null && !field.required && !field.list) return;
  if (field.list) {
    if (!Array.isArray(value)) invalidField(name);
    for (const entry of value) validateField(entry, { ...field, list: false, required: true }, name);
    return;
  }
  if (field.enumValues) {
    if (typeof value !== 'string' || !field.enumValues.includes(value)) invalidField(name);
    return;
  }
  switch (field.type) {
    case 'String':
      if (typeof value !== 'string' || (field.maxLength !== undefined && [...value].length > field.maxLength)) invalidField(name);
      if (field.id && value.length === 0) invalidField(name);
      if (field.nativeType === 'Uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalidField(name);
      return;
    case 'Boolean':
      if (typeof value !== 'boolean') invalidField(name);
      return;
    case 'Int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) invalidField(name);
      if (field.nativeType === 'SmallInt' && (value < -32768 || value > 32767)) invalidField(name);
      return;
    case 'Float':
      if (typeof value !== 'number' || !Number.isFinite(value)) invalidField(name);
      return;
    case 'BigInt':
      if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value) || value.length > 20) invalidField(name);
      if (BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n) invalidField(name);
      return;
    case 'Decimal': {
      if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$/.test(value)) invalidField(name);
      const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.');
      if (field.scale !== undefined && fraction.length > field.scale) invalidField(name);
      if (field.precision !== undefined && field.scale !== undefined && whole.replace(/^0+/, '').length > field.precision - field.scale) invalidField(name);
      return;
    }
    case 'DateTime':
      if (!isDateTime(value)) invalidField(name);
      return;
    case 'Bytes':
      if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalidField(name);
      return;
    case 'Json':
      if ((value === null && field.required) || !isJson(value)) invalidField(name);
      return;
    default: invalidField(name);
  }
}

function validateInput(input: unknown, fields: Readonly<Record<string, GeneratedField>>, required: readonly string[], allowEmpty: boolean): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalidField('body');
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) invalidField('body');
  const entries = Object.entries(input);
  if (!allowEmpty && entries.length === 0) invalidField('body');
  for (const key of required) if (!Object.hasOwn(input, key)) invalidField(key);
  for (const [key, value] of entries) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!field || value === undefined) invalidField(key);
    validateField(value, field, key);
  }
}
`;

function renderService(domain: DomainDefinition): string {
  const name = domain.name;
  const imports = [...contractImports(domain), `${name}Authorization`];
  const methods: string[] = [];
  if (enabled(domain, 'list')) methods.push(`  async list(query: ${name}ListQuery, context: Context): Promise<${name}Page> {
    await this.authorize('list', context);
    if (query === null || typeof query !== 'object' || Array.isArray(query) || (Object.getPrototypeOf(query) !== Object.prototype && Object.getPrototypeOf(query) !== null) || Object.keys(query).some((key) => key !== 'page' && key !== 'limit')) {
      throw new ApplicationError('INVALID_QUERY', 'Expected page and limit.', 400);
    }
    const page = query.page === undefined ? 1 : query.page;
    const limit = query.limit === undefined ? 20 : query.limit;
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || page < 1 || limit < 1 || limit > 100 || page > Math.floor(2147483647 / limit)) {
      throw new ApplicationError('INVALID_QUERY', 'Page must be positive and limit must be between 1 and 100.', 400);
    }
    return this.repository.list({ page, limit });
  }`);
  if (enabled(domain, 'get')) methods.push(`  async get(id: ${identifierType(domain)}, context: Context): Promise<${name}> {
    await this.authorize('get', context);
    validateIdentifier(id);
    const record = await this.repository.get(id);
    if (record === null) throw new ApplicationError('NOT_FOUND', '${name} does not exist.', 404);
    return record;
  }`);
  if (enabled(domain, 'create')) methods.push(`  async create(input: Create${name}Input, context: Context): Promise<${name}> {
    await this.authorize('create', context);
    validateInput(input, createFields, ${literal(domain.createFields.filter(requiredForCreate).map((field) => field.name))}, true);
    return this.repository.create(input);
  }`);
  if (enabled(domain, 'update')) methods.push(`  async update(id: ${identifierType(domain)}, input: Update${name}Input, context: Context): Promise<${name}> {
    await this.authorize('update', context);
    validateIdentifier(id);
    validateInput(input, updateFields, [], false);
    return this.repository.update(id, input);
  }`);
  if (enabled(domain, 'delete')) methods.push(`  async delete(id: ${identifierType(domain)}, context: Context): Promise<void> {
    await this.authorize('delete', context);
    validateIdentifier(id);
    return this.repository.delete(id);
  }`);
  const inputValidation = enabled(domain, 'create') || enabled(domain, 'update');
  const idValidation = ['get', 'update', 'delete'].some((operation) => enabled(domain, operation as CrudOperation));
  const idChecks = domain.id.type === 'Int'
    ? ["typeof id !== 'number'", '!Number.isInteger(id)', `id < ${domain.id.nativeType?.[0] === 'SmallInt' ? '-32768' : '-2147483648'}`, `id > ${domain.id.nativeType?.[0] === 'SmallInt' ? '32767' : '2147483647'}`]
    : ["typeof id !== 'string'", 'id.length === 0'];
  if (domain.id.nativeType?.[0] === 'Uuid') idChecks.push('!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)');
  if (domain.id.nativeType && ['VarChar', 'Char'].includes(domain.id.nativeType[0]) && domain.id.nativeType[1][0] !== undefined) idChecks.push(`[...id].length > ${Number(domain.id.nativeType[1][0])}`);
  return `import { ApplicationError } from '../../framework/core/errors.js';
import type { ${imports.join(', ')} } from './${name}Types.js';
import type { ${name}RepositoryContract } from './${name}Contracts.js';

${enabled(domain, 'create') ? `const createFields: Readonly<Record<string, GeneratedField>> = ${literal(Object.fromEntries(domain.createFields.map((field) => [field.name, descriptor(field)])))};\n\n` : ''}${enabled(domain, 'update') ? `const updateFields: Readonly<Record<string, GeneratedField>> = ${literal(Object.fromEntries(domain.updateFields.map((field) => [field.name, descriptor(field)])))};\n\n` : ''}${inputValidation ? `${serviceInputValidation}\n` : ''}${idValidation ? `function validateIdentifier(id: ${identifierType(domain)}): void {
  if (${idChecks.join(' || ')}) {
    throw new ApplicationError('INVALID_ID', 'Invalid ${name} identifier.', 400);
  }
}

` : ''}export class Generated${name}Service<Context> {
  constructor(
    protected readonly repository: ${name}RepositoryContract,
    protected readonly authorize: ${name}Authorization<Context>,
  ) {}

${methods.join('\n\n')}
}
`;
}

function renderController(domain: DomainDefinition): string {
  const { name } = domain;
  const imports = [`${name}Api`];
  if (enabled(domain, 'create')) imports.push(`Create${name}Input`);
  if (enabled(domain, 'update')) imports.push(`Update${name}Input`);
  const reply = enabled(domain, 'create') || enabled(domain, 'delete');
  const identifier = domain.id.type === 'Int' ? 'Number(request.params.id)' : 'request.params.id';
  const methods: string[] = [];
  if (enabled(domain, 'list')) methods.push(`  list = async (request: FastifyRequest<{ Querystring: { page?: string; limit?: string } }>) =>
    this.api.list({
      ...(request.query.page !== undefined ? { page: Number(request.query.page) } : {}),
      ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
    }, await this.context(request));`);
  if (enabled(domain, 'get')) methods.push(`  get = async (request: FastifyRequest<{ Params: { id: string } }>) =>
    this.api.get(${identifier}, await this.context(request));`);
  if (enabled(domain, 'create')) methods.push(`  create = async (request: FastifyRequest<{ Body: Create${name}Input }>, reply: FastifyReply) =>
    reply.code(201).send(await this.api.create(request.body, await this.context(request)));`);
  if (enabled(domain, 'update')) methods.push(`  update = async (request: FastifyRequest<{ Params: { id: string }; Body: Update${name}Input }>) =>
    this.api.update(${identifier}, request.body, await this.context(request));`);
  if (enabled(domain, 'delete')) methods.push(`  delete = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    await this.api.delete(${identifier}, await this.context(request));
    return reply.code(204).send();
  };`);
  return `import type { FastifyRequest${reply ? ', FastifyReply' : ''} } from 'fastify';
import type { ${imports.join(', ')} } from './${name}Types.js';

export class Generated${name}Controller<Context> {
  constructor(
    protected readonly api: ${name}Api<Context>,
    protected readonly context: (request: FastifyRequest) => Context | Promise<Context>,
  ) {}

${methods.join('\n\n')}
}
`;
}

function objectSchema(fields: readonly FieldDefinition[], mode: 'output' | 'create' | 'update'): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false,
    ...(mode === 'update' ? { minProperties: 1 } : {}),
    required: mode === 'output' ? fields.map((field) => field.name) : mode === 'create' ? fields.filter(requiredForCreate).map((field) => field.name) : [],
    properties: Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field, mode === 'output' ? 'output' : 'input')])),
  };
}

function renderRoutes(domain: DomainDefinition): string {
  const { name, route } = domain;
  const imports = [`${name}Api`, `${name}Operation`];
  if (enabled(domain, 'create')) imports.push(`Create${name}Input`);
  if (enabled(domain, 'update')) imports.push(`Update${name}Input`);
  const schemas: string[] = [];
  const needsRecord = domain.operations.some((operation) => operation !== 'delete');
  if (needsRecord) schemas.push(`const recordSchema = ${literal({ $id: `crud.${domain.domain}.${name}`, ...objectSchema(domain.readFields, 'output') })} as const;`);
  if (enabled(domain, 'create')) schemas.push(`const createSchema = ${literal(objectSchema(domain.createFields, 'create'))} as const;`);
  if (enabled(domain, 'update')) schemas.push(`const updateSchema = ${literal(objectSchema(domain.updateFields, 'update'))} as const;`);
  const idOperations = ['get', 'update', 'delete'].some((operation) => enabled(domain, operation as CrudOperation));
  if (idOperations) schemas.push(`const identifierSchema = ${literal({ type: 'object', additionalProperties: false, required: ['id'], properties: { id: domain.id.type === 'Int' ? { type: 'string', pattern: '^-?(?:0|[1-9][0-9]*)$', maxLength: 11 } : { type: 'string', minLength: 1 } } })} as const;`);
  const statements: string[] = [];
  if (enabled(domain, 'list')) statements.push(`  server.get<{ Querystring: { page?: string; limit?: string } }>(${quote(route)}, {
    ...(access.list ? { preHandler: access.list } : {}),
    schema: {
      tags: [${quote(name)}], summary: ${quote(`List ${domain.domain}`)},
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 }, limit: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 3 } },
      },
      response: { 200: {
        type: 'object', additionalProperties: false, required: ['items', 'total', 'page', 'limit'],
        properties: { items: { type: 'array', items: { $ref: ${quote(`crud.${domain.domain}.${name}#`)} } }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } },
      }, ...errors },
    },
    handler: controller.list,
  });`);
  if (enabled(domain, 'get')) statements.push(`  server.get<{ Params: { id: string } }>(${quote(`${route}/:id`)}, {
    ...(access.get ? { preHandler: access.get } : {}),
    schema: { tags: [${quote(name)}], summary: ${quote(`Get ${name}`)}, params: identifierSchema, response: { 200: { $ref: ${quote(`crud.${domain.domain}.${name}#`)} }, ...errors } },
    handler: controller.get,
  });`);
  if (enabled(domain, 'create')) statements.push(`  server.post<{ Body: Create${name}Input }>(${quote(route)}, {
    ...(access.create ? { preHandler: access.create } : {}),
    schema: { tags: [${quote(name)}], summary: ${quote(`Create ${name}`)}, body: createSchema, response: { 201: { $ref: ${quote(`crud.${domain.domain}.${name}#`)} }, ...errors } },
    handler: controller.create,
  });`);
  if (enabled(domain, 'update')) statements.push(`  server.patch<{ Params: { id: string }; Body: Update${name}Input }>(${quote(`${route}/:id`)}, {
    ...(access.update ? { preHandler: access.update } : {}),
    schema: { tags: [${quote(name)}], summary: ${quote(`Update ${name}`)}, params: identifierSchema, body: updateSchema, response: { 200: { $ref: ${quote(`crud.${domain.domain}.${name}#`)} }, ...errors } },
    handler: controller.update,
  });`);
  if (enabled(domain, 'delete')) statements.push(`  server.delete<{ Params: { id: string } }>(${quote(`${route}/:id`)}, {
    ...(access.delete ? { preHandler: access.delete } : {}),
    schema: { tags: [${quote(name)}], summary: ${quote(`Delete ${name}`)}, params: identifierSchema, response: { 204: { type: 'null' }, ...errors } },
    handler: controller.delete,
  });`);
  return `import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type {} from '@fastify/swagger';
import type { ${imports.join(', ')} } from './${name}Types.js';
import { ${name}Controller } from './${name}Controller.js';
import { errors } from '../../framework/http/error-schema.js';

${schemas.join('\n\n')}

export type ${name}RouteAccess = Readonly<Partial<Record<${name}Operation, preHandlerHookHandler | preHandlerHookHandler[]>>>;

export function register${name}CrudRoutes<Context>(
  server: FastifyInstance,
  api: ${name}Api<Context>,
  context: (request: FastifyRequest) => Context | Promise<Context>,
  access: ${name}RouteAccess = {},
): void {
${needsRecord ? '  server.addSchema(recordSchema);\n' : ''}  const controller = new ${name}Controller(api, context);

${statements.join('\n\n')}
}
`;
}

/** Both TypeScript DTOs and the schemas beside routes come from the same model. */
export function renderDomain(domain: DomainDefinition): GeneratedFile[] {
  const name = domain.name;
  const files = [
    { role: 'Types', generated: renderTypes(domain), extension: `// Add custom public contracts here. This section is preserved during generation.\nexport interface ${name}Api<Context> extends ${name}CrudApi<Context> {}\n` },
    { role: 'Contracts', generated: renderContracts(domain), extension: '// Add domain-specific internal ports here.\n' },
    { role: 'Repository', generated: renderRepository(domain), extension: `// Add custom persistence methods here. This section is preserved during generation.\nexport class ${name}Repository extends Generated${name}Repository {}\n` },
    { role: 'Service', generated: renderService(domain), extension: `// Add domain scenarios and policy overrides here. This section is preserved during generation.\nimport type { ${name}Api } from './${name}Types.js';\n\nexport class ${name}Service<Context> extends Generated${name}Service<Context> implements ${name}Api<Context> {}\n` },
    { role: 'Controller', generated: renderController(domain), extension: `// Add custom HTTP handlers here. This section is preserved during generation.\nexport class ${name}Controller<Context> extends Generated${name}Controller<Context> {}\n` },
    { role: 'Routes', generated: renderRoutes(domain), extension: `// Register custom routes here. This section is preserved during generation.\nexport function register${name}Routes<Context>(\n  server: FastifyInstance,\n  api: ${name}Api<Context>,\n  context: (request: FastifyRequest) => Context | Promise<Context>,\n): void {\n  register${name}CrudRoutes(server, api, context);\n}\n` },
  ];
  return files.map(({ role, generated, extension }) => ({ path: `src/${domain.domain}/${name}${role}.ts`, generated, extension }));
}
