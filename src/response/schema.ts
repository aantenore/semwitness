import {
  immutableJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import type {
  BoundedJsonScalar,
  BoundedJsonSchema,
  CompactResponseLimits,
} from './types.js';

export const MAX_BOUNDED_JSON_SCHEMA_NODES = 4_096;
export const MAX_BOUNDED_JSON_SCHEMA_ENUM_VALUES = 256;

export const COMPACT_RESPONSE_LIMIT_CAPS = Object.freeze({
  maxCandidateBytes: 4 * 1024 * 1024,
  maxRenderedBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxItems: 100_000,
  maxStringCodeUnits: 1024 * 1024,
  maxRenderMs: 30_000,
});

interface SchemaParseContext {
  readonly limits: CompactResponseLimits;
  nodes: number;
}

export function parseBoundedJsonSchema(
  source: JsonValue,
  limits: CompactResponseLimits,
): BoundedJsonSchema {
  const context: SchemaParseContext = { limits, nodes: 0 };
  const schema = parseSchemaNode(source, context, 0);
  return immutableJson(toJsonValue(schema)) as unknown as BoundedJsonSchema;
}

export function matchesBoundedJsonSchema(
  value: JsonValue,
  schema: BoundedJsonSchema,
): boolean {
  switch (schema.type) {
    case 'null':
      return value === null && matchesEnum(value, schema.enum);
    case 'boolean':
      return typeof value === 'boolean' && matchesEnum(value, schema.enum);
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        matchesEnum(value, schema.enum) &&
        withinNumericBounds(value, schema.minimum, schema.maximum)
      );
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        matchesEnum(value, schema.enum) &&
        withinNumericBounds(value, schema.minimum, schema.maximum)
      );
    case 'string':
      return (
        typeof value === 'string' &&
        matchesEnum(value, schema.enum) &&
        (schema.minLength === undefined || value.length >= schema.minLength) &&
        (schema.maxLength === undefined || value.length <= schema.maxLength)
      );
    case 'array':
      return matchesArray(value, schema);
    case 'object':
      return matchesObject(value, schema);
  }
}

function parseSchemaNode(
  source: JsonValue,
  context: SchemaParseContext,
  depth: number,
): BoundedJsonSchema {
  context.nodes += 1;
  if (
    context.nodes > MAX_BOUNDED_JSON_SCHEMA_NODES ||
    depth > context.limits.maxDepth
  ) {
    throw invalidSchema();
  }
  const record = asRecord(source);
  const type = record.type;
  switch (type) {
    case 'null':
      return parseNullSchema(record);
    case 'boolean':
      return parseBooleanSchema(record);
    case 'number':
      return parseNumberSchema(record, false);
    case 'integer':
      return parseNumberSchema(record, true);
    case 'string':
      return parseStringSchema(record, context.limits);
    case 'array':
      return parseArraySchema(record, context, depth);
    case 'object':
      return parseObjectSchema(record, context, depth);
    default:
      throw invalidSchema();
  }
}

function parseNullSchema(
  record: Readonly<Record<string, JsonValue>>,
): BoundedJsonSchema {
  assertAllowedFields(record, ['type', 'enum']);
  const enumeration = parseScalarEnum(record.enum, 'null');
  return enumeration === undefined
    ? { type: 'null' }
    : { type: 'null', enum: enumeration as readonly null[] };
}

function parseBooleanSchema(
  record: Readonly<Record<string, JsonValue>>,
): BoundedJsonSchema {
  assertAllowedFields(record, ['type', 'enum']);
  const enumeration = parseScalarEnum(record.enum, 'boolean');
  return enumeration === undefined
    ? { type: 'boolean' }
    : { type: 'boolean', enum: enumeration as readonly boolean[] };
}

function parseNumberSchema(
  record: Readonly<Record<string, JsonValue>>,
  integer: boolean,
): BoundedJsonSchema {
  assertAllowedFields(record, ['type', 'enum', 'minimum', 'maximum']);
  const enumeration = parseScalarEnum(
    record.enum,
    integer ? 'integer' : 'number',
  ) as readonly number[] | undefined;
  const minimum = optionalNumber(record.minimum, integer);
  const maximum = optionalNumber(record.maximum, integer);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw invalidSchema();
  }
  if (
    enumeration?.some(
      (value) => !withinNumericBounds(value, minimum, maximum),
    ) === true
  ) {
    throw invalidSchema();
  }
  const bounds = {
    ...(enumeration === undefined ? {} : { enum: enumeration }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
  return integer
    ? { type: 'integer', ...bounds }
    : { type: 'number', ...bounds };
}

function parseStringSchema(
  record: Readonly<Record<string, JsonValue>>,
  limits: CompactResponseLimits,
): BoundedJsonSchema {
  assertAllowedFields(record, ['type', 'enum', 'minLength', 'maxLength']);
  const enumeration = parseScalarEnum(record.enum, 'string') as
    readonly string[] | undefined;
  const minLength = optionalBoundedInteger(
    record.minLength,
    limits.maxStringCodeUnits,
  );
  const maxLength = optionalBoundedInteger(
    record.maxLength,
    limits.maxStringCodeUnits,
  );
  if (
    (enumeration === undefined && maxLength === undefined) ||
    (minLength !== undefined &&
      maxLength !== undefined &&
      minLength > maxLength)
  ) {
    throw invalidSchema();
  }
  if (
    enumeration?.some((value) => {
      assertWellFormedUnicode(value, 'Bounded schema enum string');
      return (
        value.length > limits.maxStringCodeUnits ||
        (minLength !== undefined && value.length < minLength) ||
        (maxLength !== undefined && value.length > maxLength)
      );
    }) === true
  ) {
    throw invalidSchema();
  }
  return {
    type: 'string',
    ...(enumeration === undefined ? {} : { enum: enumeration }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
  };
}

function parseArraySchema(
  record: Readonly<Record<string, JsonValue>>,
  context: SchemaParseContext,
  depth: number,
): BoundedJsonSchema {
  const hasPrefixItems = Object.hasOwn(record, 'prefixItems');
  const minItems = optionalBoundedInteger(
    record.minItems,
    context.limits.maxItems,
  );
  const maxItems = requiredBoundedInteger(
    record.maxItems,
    context.limits.maxItems,
  );
  if ((minItems ?? 0) > maxItems) throw invalidSchema();

  if (!hasPrefixItems) {
    assertAllowedFields(record, ['type', 'items', 'minItems', 'maxItems']);
    if (!Object.hasOwn(record, 'items') || record.items === false) {
      throw invalidSchema();
    }
    const items = parseSchemaNode(record.items!, context, depth + 1);
    return {
      type: 'array',
      items,
      ...(minItems === undefined ? {} : { minItems }),
      maxItems,
    };
  }

  assertExactFields(record, [
    'type',
    'prefixItems',
    'items',
    'minItems',
    'maxItems',
  ]);
  if (
    record.items !== false ||
    !Array.isArray(record.prefixItems) ||
    record.prefixItems.length > context.limits.maxItems ||
    maxItems > record.prefixItems.length ||
    minItems === undefined
  ) {
    throw invalidSchema();
  }
  const prefixItems = record.prefixItems.map((item) =>
    parseSchemaNode(item, context, depth + 1),
  );
  return {
    type: 'array',
    prefixItems,
    items: false,
    minItems,
    maxItems,
  };
}

function parseObjectSchema(
  record: Readonly<Record<string, JsonValue>>,
  context: SchemaParseContext,
  depth: number,
): BoundedJsonSchema {
  assertExactFields(record, [
    'type',
    'properties',
    'required',
    'additionalProperties',
  ]);
  const propertiesSource = asRecord(record.properties!);
  if (
    record.additionalProperties !== false ||
    !Array.isArray(record.required) ||
    Object.keys(propertiesSource).length > context.limits.maxItems ||
    record.required.length > context.limits.maxItems
  ) {
    throw invalidSchema();
  }

  const properties: Record<string, BoundedJsonSchema> = Object.create(
    null,
  ) as Record<string, BoundedJsonSchema>;
  for (const key of Object.keys(propertiesSource).sort()) {
    assertSchemaString(key, context.limits);
    properties[key] = parseSchemaNode(
      propertiesSource[key]!,
      context,
      depth + 1,
    );
  }

  const required: string[] = [];
  const seen = new Set<string>();
  for (const item of record.required) {
    if (typeof item !== 'string') throw invalidSchema();
    assertSchemaString(item, context.limits);
    if (seen.has(item) || !Object.hasOwn(properties, item)) {
      throw invalidSchema();
    }
    seen.add(item);
    required.push(item);
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function parseScalarEnum(
  value: JsonValue | undefined,
  expected: 'null' | 'boolean' | 'number' | 'integer' | 'string',
): readonly BoundedJsonScalar[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_BOUNDED_JSON_SCHEMA_ENUM_VALUES
  ) {
    throw invalidSchema();
  }
  const seen = new Set<string>();
  const result: BoundedJsonScalar[] = [];
  for (const item of value) {
    if (!isExpectedScalar(item, expected)) throw invalidSchema();
    const key = `${typeof item}:${String(item)}`;
    if (seen.has(key)) throw invalidSchema();
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isExpectedScalar(
  value: JsonValue,
  expected: 'null' | 'boolean' | 'number' | 'integer' | 'string',
): value is BoundedJsonScalar {
  if (expected === 'null') return value === null;
  if (expected === 'integer') {
    return typeof value === 'number' && Number.isSafeInteger(value);
  }
  return typeof value === expected;
}

function optionalNumber(
  value: JsonValue | undefined,
  integer: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw invalidSchema();
  }
  return value;
}

function optionalBoundedInteger(
  value: JsonValue | undefined,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  return requiredBoundedInteger(value, maximum);
}

function requiredBoundedInteger(value: JsonValue | undefined, maximum: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw invalidSchema();
  }
  return value;
}

function matchesArray(
  value: JsonValue,
  schema: Extract<BoundedJsonSchema, { readonly type: 'array' }>,
): boolean {
  if (
    !Array.isArray(value) ||
    value.length < (schema.minItems ?? 0) ||
    value.length > schema.maxItems
  ) {
    return false;
  }
  if ('prefixItems' in schema) {
    return value.every((item, index) => {
      const itemSchema = schema.prefixItems[index];
      return (
        itemSchema !== undefined && matchesBoundedJsonSchema(item, itemSchema)
      );
    });
  }
  return value.every((item) => matchesBoundedJsonSchema(item, schema.items));
}

function matchesObject(
  value: JsonValue,
  schema: Extract<BoundedJsonSchema, { readonly type: 'object' }>,
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const record = value as Readonly<Record<string, JsonValue>>;
  if (keys.some((key) => !Object.hasOwn(schema.properties, key))) return false;
  if (schema.required.some((key) => !Object.hasOwn(value, key))) return false;
  return keys.every((key) =>
    matchesBoundedJsonSchema(record[key]!, schema.properties[key]!),
  );
}

function matchesEnum(
  value: BoundedJsonScalar,
  enumeration: readonly BoundedJsonScalar[] | undefined,
): boolean {
  return (
    enumeration === undefined || enumeration.some((item) => item === value)
  );
}

function withinNumericBounds(
  value: number,
  minimum: number | undefined,
  maximum: number | undefined,
): boolean {
  return (
    (minimum === undefined || value >= minimum) &&
    (maximum === undefined || value <= maximum)
  );
}

function asRecord(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidSchema();
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function assertAllowedFields(
  record: Readonly<Record<string, JsonValue>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw invalidSchema();
  }
}

function assertExactFields(
  record: Readonly<Record<string, JsonValue>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(record);
  const expectedSet = new Set(expected);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expectedSet.has(key))
  ) {
    throw invalidSchema();
  }
}

function assertSchemaString(
  value: string,
  limits: CompactResponseLimits,
): void {
  assertWellFormedUnicode(value, 'Bounded schema string');
  if (value.length > limits.maxStringCodeUnits) throw invalidSchema();
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} must be well-formed Unicode`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${label} must be well-formed Unicode`);
    }
  }
}

function invalidSchema(): TypeError {
  return new TypeError('Malformed bounded JSON schema');
}
