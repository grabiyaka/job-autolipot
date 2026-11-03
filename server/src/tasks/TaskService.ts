// <framework:generated sha256=e0cd042df631fa3dd7b41cd46104c9a0ef1de4e24f0a73927eb96ab427a31115>
import { ApplicationError } from '../../framework/core/errors.js';
import type { Task, TaskListQuery, TaskPage, CreateTaskInput, UpdateTaskInput, TaskAuthorization } from './TaskTypes.js';
import type { TaskRepositoryContract } from './TaskContracts.js';

const createFields: Readonly<Record<string, GeneratedField>> = {
  "title": {
    "type": "String",
    "required": true,
    "list": false,
    "id": false
  },
  "description": {
    "type": "String",
    "required": false,
    "list": false,
    "id": false
  },
  "completed": {
    "type": "Boolean",
    "required": true,
    "list": false,
    "id": false
  },
  "priority": {
    "type": "Int",
    "required": true,
    "list": false,
    "id": false
  },
  "status": {
    "type": "TaskStatus",
    "required": true,
    "list": false,
    "id": false,
    "enumValues": [
      "OPEN",
      "IN_PROGRESS",
      "DONE"
    ]
  },
  "dueAt": {
    "type": "DateTime",
    "required": false,
    "list": false,
    "id": false,
    "nativeType": "Timestamptz"
  },
  "tags": {
    "type": "String",
    "required": true,
    "list": true,
    "id": false
  }
};

const updateFields: Readonly<Record<string, GeneratedField>> = {
  "title": {
    "type": "String",
    "required": true,
    "list": false,
    "id": false
  },
  "description": {
    "type": "String",
    "required": false,
    "list": false,
    "id": false
  },
  "completed": {
    "type": "Boolean",
    "required": true,
    "list": false,
    "id": false
  },
  "priority": {
    "type": "Int",
    "required": true,
    "list": false,
    "id": false
  },
  "status": {
    "type": "TaskStatus",
    "required": true,
    "list": false,
    "id": false,
    "enumValues": [
      "OPEN",
      "IN_PROGRESS",
      "DONE"
    ]
  },
  "dueAt": {
    "type": "DateTime",
    "required": false,
    "list": false,
    "id": false,
    "nativeType": "Timestamptz"
  },
  "tags": {
    "type": "String",
    "required": true,
    "list": true,
    "id": false
  }
};

type GeneratedField = Readonly<{
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
  const date = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
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
      if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) invalidField(name);
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

function validateIdentifier(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new ApplicationError('INVALID_ID', 'Invalid Task identifier.', 400);
  }
}

export class GeneratedTaskService<Context> {
  constructor(
    protected readonly repository: TaskRepositoryContract,
    protected readonly authorize: TaskAuthorization<Context>,
  ) {}

  async list(query: TaskListQuery, context: Context): Promise<TaskPage> {
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
  }

  async get(id: string, context: Context): Promise<Task> {
    await this.authorize('get', context);
    validateIdentifier(id);
    const record = await this.repository.get(id);
    if (record === null) throw new ApplicationError('NOT_FOUND', 'Task does not exist.', 404);
    return record;
  }

  async create(input: CreateTaskInput, context: Context): Promise<Task> {
    await this.authorize('create', context);
    validateInput(input, createFields, [
  "title"
], true);
    return this.repository.create(input);
  }

  async update(id: string, input: UpdateTaskInput, context: Context): Promise<Task> {
    await this.authorize('update', context);
    validateIdentifier(id);
    validateInput(input, updateFields, [], false);
    return this.repository.update(id, input);
  }

  async delete(id: string, context: Context): Promise<void> {
    await this.authorize('delete', context);
    validateIdentifier(id);
    return this.repository.delete(id);
  }
}
// </framework:generated>
// Add domain scenarios and policy overrides here. This section is preserved during generation.
import type { TaskApi } from './TaskTypes.js';

export class TaskService<Context> extends GeneratedTaskService<Context> implements TaskApi<Context> {}
