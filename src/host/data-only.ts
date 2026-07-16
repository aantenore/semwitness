import { compareCodeUnits } from '../domain/deterministic-order.js';

/**
 * Copy a bounded record through own data descriptors only.
 *
 * The returned null-prototype snapshot contains no reference to the source
 * object and no accessor is ever invoked.
 */
export function snapshotDataRecord(
  value: unknown,
  expectedFields: readonly string[],
): Readonly<Record<string, unknown>> {
  const prototype =
    value !== null && typeof value === 'object'
      ? Reflect.getPrototypeOf(value)
      : undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw invalidDataOnlyValue();
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw invalidDataOnlyValue();
  }
  const actualFields = (ownKeys as string[]).sort(compareCodeUnits);
  const expected = [...expectedFields].sort(compareCodeUnits);
  if (
    actualFields.length !== expected.length ||
    actualFields.some((key, index) => key !== expected[index])
  ) {
    throw invalidDataOnlyValue();
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const field of expectedFields) {
    snapshot[field] = dataDescriptorValue(value, field, true);
  }
  return Object.freeze(snapshot);
}

/** Copy a bounded dense array without invoking accessors or retaining aliases. */
export function snapshotDenseDataArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype
  ) {
    throw invalidDataOnlyValue();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw invalidDataOnlyValue();
  }
  const stringKeys = ownKeys as string[];
  const length = dataDescriptorValue(value, 'length', false);
  if (
    !Number.isSafeInteger(length) ||
    Object.is(length, -0) ||
    (length as number) < minimumLength ||
    (length as number) > maximumLength
  ) {
    throw invalidDataOnlyValue();
  }
  if (stringKeys.length !== (length as number) + 1) {
    throw invalidDataOnlyValue();
  }

  const keySet = new Set(stringKeys);
  if (!keySet.has('length')) {
    throw invalidDataOnlyValue();
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const field = String(index);
    if (!keySet.has(field)) {
      throw invalidDataOnlyValue();
    }
    snapshot.push(dataDescriptorValue(value, field, true));
  }
  return Object.freeze(snapshot);
}

function dataDescriptorValue(
  value: object,
  field: PropertyKey,
  enumerable: boolean,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  ) {
    throw invalidDataOnlyValue();
  }
  return descriptor.value;
}

function invalidDataOnlyValue(): TypeError {
  return new TypeError('Value must be bounded data-only state');
}
