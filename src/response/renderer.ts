import type { JsonValue } from '../domain/canonical-json.js';
import type { Sha256Digest } from '../domain/types.js';

export interface CompactResponseRendererContext {
  readonly locale: string;
  readonly signal: AbortSignal;
}

export interface CompactResponseRenderer {
  readonly id: string;
  readonly version: string;
  readonly artifactDigest: Sha256Digest;
  readonly outputMediaType: string;
  readonly locales: readonly string[];
  render(
    candidate: JsonValue,
    context: CompactResponseRendererContext,
  ): string | Uint8Array | Promise<string | Uint8Array>;
}
