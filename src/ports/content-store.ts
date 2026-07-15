import type { Sha256Digest } from '../domain/types.js';

export interface ContentStore {
  put(bytes: Uint8Array): Promise<Sha256Digest>;
  get(reference: Sha256Digest): Promise<Uint8Array>;
  has(reference: Sha256Digest): Promise<boolean>;
}
