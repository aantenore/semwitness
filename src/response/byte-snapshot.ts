const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get;
const typedArraySet = Uint8Array.prototype.set;
const ordinaryHasInstance = Function.prototype[Symbol.hasInstance];

export type BoundedByteSnapshot =
  | { readonly status: 'ok'; readonly bytes: Uint8Array }
  | { readonly status: 'invalid' }
  | { readonly status: 'too-large' };

/**
 * Copies a Uint8Array without trusting own properties, iterators, species, or
 * an overridable byteLength lookup on caller-controlled input.
 */
export function snapshotBoundedUint8Array(
  value: unknown,
  maximumBytes: number,
): BoundedByteSnapshot {
  try {
    if (
      typedArrayByteLength === undefined ||
      !Reflect.apply(ordinaryHasInstance, Uint8Array, [value])
    ) {
      return { status: 'invalid' };
    }
    const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    if (byteLength > maximumBytes) return { status: 'too-large' };

    const bytes = new Uint8Array(byteLength);
    Reflect.apply(typedArraySet, bytes, [value, 0]);
    const copiedByteLength = Reflect.apply(
      typedArrayByteLength,
      bytes,
      [],
    ) as number;
    if (copiedByteLength !== byteLength || copiedByteLength > maximumBytes) {
      return { status: 'invalid' };
    }
    return { status: 'ok', bytes };
  } catch {
    return { status: 'invalid' };
  }
}
