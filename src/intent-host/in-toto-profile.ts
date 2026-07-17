import { Buffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';

import { sha256 } from '../domain/hash.js';
import {
  parseStrictJson,
  type StrictJsonLimits,
} from '../domain/strict-json.js';
import type { Sha256Digest } from '../domain/types.js';
import { snapshotDenseDataArray } from '../host/data-only.js';

const CANONICAL_RFC3339_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface InTotoProfileParseContext {
  extensionsPresent: boolean;
  extensionItems: number;
  readonly extensionObjects: WeakSet<object>;
  readonly limits: StrictJsonLimits;
}

export function createInTotoProfileParseContext(
  limits: StrictJsonLimits,
): InTotoProfileParseContext {
  return {
    extensionsPresent: false,
    extensionItems: 0,
    extensionObjects: new WeakSet<object>(),
    limits,
  };
}

export function parseInTotoProfileSource(
  source: unknown,
  maximumBytes: number,
  limits: StrictJsonLimits,
): unknown {
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > maximumBytes) {
      throw invalidProfile();
    }
    return parseStrictJson(source, limits);
  }
  if (source instanceof Uint8Array) {
    if (source.byteLength > maximumBytes) throw invalidProfile();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    return parseStrictJson(text, limits);
  }
  return source;
}

/**
 * Snapshot required fields without invoking accessors. Unknown fields are
 * accepted monotonically, validated as bounded data-only state, and discarded.
 */
export function snapshotRequiredInTotoProfileRecord<const Field extends string>(
  source: unknown,
  requiredFields: readonly Field[],
  maximumFields: number,
  context: InTotoProfileParseContext,
  recordDepth: number,
): Readonly<Record<Field, unknown>> {
  if (
    utilTypes.isProxy(source) ||
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    throw invalidProfile();
  }
  const prototype = Reflect.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidProfile();
  }
  const ownKeys = Reflect.ownKeys(source);
  if (
    ownKeys.length > maximumFields ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        key.length > context.limits.maxStringCodeUnits,
    )
  ) {
    throw invalidProfile();
  }

  const values: Partial<Record<Field, unknown>> = Object.create(
    null,
  ) as Partial<Record<Field, unknown>>;
  const required = new Set<string>(requiredFields);
  for (const key of ownKeys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      Object.hasOwn(descriptor, 'get') ||
      Object.hasOwn(descriptor, 'set')
    ) {
      throw invalidProfile();
    }
    if (required.has(key)) {
      values[key as Field] = descriptor.value;
    } else {
      context.extensionsPresent = true;
      validateExtensionValue(descriptor.value, context, recordDepth + 1);
    }
  }
  if (requiredFields.some((field) => !Object.hasOwn(values, field))) {
    throw invalidProfile();
  }
  return Object.freeze(values as Record<Field, unknown>);
}

export function parseCanonicalRfc3339Utc(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_RFC3339_UTC_PATTERN.test(value)) {
    throw invalidProfile();
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw invalidProfile();
  }
  return value;
}

export function toCanonicalRfc3339Utc(epochMs: number): string {
  const instant = new Date(epochMs);
  if (!Number.isFinite(instant.getTime())) throw invalidProfile();
  return parseCanonicalRfc3339Utc(instant.toISOString());
}

export function digestExactInTotoPayload(source: unknown): Sha256Digest | null {
  if (typeof source === 'string' || source instanceof Uint8Array) {
    return sha256(source);
  }
  return null;
}

function validateExtensionValue(
  value: unknown,
  context: InTotoProfileParseContext,
  depth: number,
): void {
  context.extensionItems += 1;
  if (
    context.extensionItems > context.limits.maxItems ||
    depth > context.limits.maxDepth
  ) {
    throw invalidProfile();
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > context.limits.maxStringCodeUnits) {
      throw invalidProfile();
    }
    return;
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw invalidProfile();
    }
    return;
  }
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    utilTypes.isProxy(value)
  ) {
    throw invalidProfile();
  }
  if (context.extensionObjects.has(value)) throw invalidProfile();
  context.extensionObjects.add(value);
  try {
    if (Array.isArray(value)) {
      const remaining = context.limits.maxItems - context.extensionItems;
      const items = snapshotDenseDataArray(value, 0, remaining);
      for (const item of items) {
        validateExtensionValue(item, context, depth + 1);
      }
      return;
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidProfile();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > context.limits.maxItems - context.extensionItems ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          key.length > context.limits.maxStringCodeUnits,
      )
    ) {
      throw invalidProfile();
    }
    for (const key of keys as string[]) {
      context.extensionItems += 1;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        context.extensionItems > context.limits.maxItems ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')
      ) {
        throw invalidProfile();
      }
      validateExtensionValue(descriptor.value, context, depth + 1);
    }
  } finally {
    context.extensionObjects.delete(value);
  }
}

function invalidProfile(): TypeError {
  return new TypeError('Malformed bounded in-toto profile');
}
