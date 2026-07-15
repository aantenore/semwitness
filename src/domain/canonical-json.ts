import { SemWitnessError } from './errors.js';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  return serialize(value, new Set<object>());
}

export function immutableJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableJson(item)));
  }
  const source = value as { readonly [key: string]: JsonValue };
  const clone: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const key of Object.keys(source).sort()) {
    clone[key] = immutableJson(source[key]!);
  }
  return Object.freeze(clone);
}

export function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SemWitnessError(
        'MALFORMED_ENVELOPE',
        'Canonical JSON rejects non-finite numbers',
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isPlainObject(value)) {
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined) {
        continue;
      }
      result[key] = toJsonValue(item);
    }
    return result;
  }
  throw new SemWitnessError(
    'MALFORMED_ENVELOPE',
    `Value of type ${typeof value} is not canonical JSON`,
  );
}

function serialize(value: JsonValue, seen: Set<object>): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SemWitnessError(
        'MALFORMED_ENVELOPE',
        'Canonical JSON rejects non-finite numbers',
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (seen.has(value)) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Canonical JSON rejects cyclic values',
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, seen)).join(',')}]`;
    }
    const object = value as { readonly [key: string]: JsonValue };
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(object[key]!, seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
