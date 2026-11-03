import type { FieldDefinition } from './model.js';

type Direction = 'input' | 'output';
type JsonSchema = Record<string, unknown>;

/** Public contracts use JSON-compatible values, never Prisma-specific scalar objects. */
export function fieldType(field: FieldDefinition, mode: Direction = 'output'): string {
  const scalar = scalarType(field, mode);
  const type = field.isList ? `Array<${scalar}>` : scalar;
  return !field.isRequired && type !== 'JsonValue' ? `${type} | null` : type;
}

export function fieldSchema(field: FieldDefinition, mode: Direction = 'input'): JsonSchema {
  const scalar = scalarSchema(field, mode);
  const schema = field.isList ? { type: 'array', items: scalar } : scalar;
  const alreadyAllowsNull = field.type === 'Json' && mode === 'output' && !field.isList;
  return field.isRequired || alreadyAllowsNull ? schema : { anyOf: [schema, { type: 'null' }] };
}

/** Callers guard omitted optional properties before applying an input conversion. */
export function inputValue(field: FieldDefinition, expression: string): string {
  const converted = field.isList
    ? arrayConversion(field, expression, 'input')
    : scalarInputValue(field, expression);
  if (field.isRequired) return converted;
  const empty = field.type === 'Json' && !field.isList ? 'Prisma.DbNull' : 'null';
  return `${expression} === null ? ${empty} : ${converted}`;
}

export function outputValue(field: FieldDefinition, expression: string): string {
  const converted = field.isList
    ? arrayConversion(field, expression, 'output')
    : scalarOutputValue(field, expression);
  return !field.isRequired && converted !== expression
    ? `${expression} === null ? null : ${converted}`
    : converted;
}

function scalarType(field: FieldDefinition, mode: Direction): string {
  if (field.kind === 'enum') return field.enumValues.map((value) => JSON.stringify(value)).join(' | ');
  switch (field.type) {
    case 'String':
    case 'DateTime':
    case 'Decimal':
    case 'BigInt':
    case 'Bytes':
      return 'string';
    case 'Int':
    case 'Float':
      return 'number';
    case 'Boolean':
      return 'boolean';
    case 'Json':
      return mode === 'input' && (field.isRequired || field.isList)
        ? 'Exclude<JsonValue, null>'
        : 'JsonValue';
    default:
      throw new Error(`Unsupported scalar ${field.type} for field ${field.name}`);
  }
}

function scalarSchema(field: FieldDefinition, mode: Direction): JsonSchema {
  if (field.kind === 'enum') return { type: 'string', enum: [...field.enumValues] };
  switch (field.type) {
    case 'String': {
      const schema: JsonSchema = { type: 'string' };
      if (field.isId && mode === 'input') schema.minLength = 1;
      const [native, args] = field.nativeType ?? ['', []];
      if ((native === 'VarChar' || native === 'Char') && args[0]) schema.maxLength = Number(args[0]);
      if (native === 'Uuid') schema.format = 'uuid';
      return schema;
    }
    case 'Int':
      return field.nativeType?.[0] === 'SmallInt'
        ? { type: 'integer', minimum: -32768, maximum: 32767 }
        : { type: 'integer', minimum: -2147483648, maximum: 2147483647 };
    case 'Float':
      return { type: 'number' };
    case 'Boolean':
      return { type: 'boolean' };
    case 'DateTime':
      return mode === 'input'
        ? { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$' }
        : { type: 'string', format: 'date-time' };
    case 'Decimal':
      return { type: 'string', pattern: decimalPattern(field) };
    case 'BigInt':
      // The generated service also checks the signed 64-bit range before persistence.
      return { type: 'string', pattern: '^-?(?:0|[1-9][0-9]*)$', maxLength: 20 };
    case 'Bytes':
      return { type: 'string', pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' };
    case 'Json': {
      const variants: JsonSchema[] = [
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'object', additionalProperties: true },
        { type: 'array', items: {} },
      ];
      if (mode === 'output') variants.push({ type: 'null' });
      return { anyOf: variants };
    }
    default:
      throw new Error(`Unsupported scalar ${field.type} for field ${field.name}`);
  }
}

function decimalPattern(field: FieldDefinition): string {
  const [native, args] = field.nativeType ?? ['', []];
  if (native !== 'Decimal' || args.length < 2) return '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$';
  const precision = Number(args[0]);
  const scale = Number(args[1]);
  const integerDigits = precision - scale;
  const integer = integerDigits > 0 ? `(?:0|[1-9][0-9]{0,${integerDigits - 1}})` : '0';
  const fraction = scale > 0 ? `(?:\\.[0-9]{1,${scale}})?` : '';
  return `^-?${integer}${fraction}$`;
}

function arrayConversion(field: FieldDefinition, expression: string, direction: Direction): string {
  const convert = direction === 'input' ? scalarInputValue : scalarOutputValue;
  const item = convert(field, 'value');
  return item === 'value' ? expression : `${expression}.map((value) => ${item})`;
}

function scalarInputValue(field: FieldDefinition, expression: string): string {
  if (field.kind === 'enum') return expression;
  switch (field.type) {
    case 'DateTime': return `new Date(${expression})`;
    case 'Decimal': return `new Prisma.Decimal(${expression})`;
    case 'BigInt': return `BigInt(${expression})`;
    case 'Bytes': return `Buffer.from(${expression}, 'base64')`;
    default: return expression;
  }
}

function scalarOutputValue(field: FieldDefinition, expression: string): string {
  if (field.kind === 'enum') return expression;
  switch (field.type) {
    case 'DateTime': return `${expression}.toISOString()`;
    case 'Decimal': return `${expression}.toFixed()`;
    case 'BigInt': return `${expression}.toString()`;
    case 'Bytes': return `Buffer.from(${expression}).toString('base64')`;
    case 'Json': return `jsonFromDatabase(${expression})`;
    default: return expression;
  }
}
