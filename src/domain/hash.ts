import { createHash } from 'node:crypto';
import type { JsonValue } from './canonical-json.js';
import { canonicalJson } from './canonical-json.js';
import type { Sha256Digest } from './types.js';

export function sha256(value: Uint8Array | string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function hashCanonical(value: JsonValue): Sha256Digest {
  return sha256(canonicalJson(value));
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}
