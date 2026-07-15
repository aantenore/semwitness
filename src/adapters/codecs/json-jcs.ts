import { canonicalJson } from '../../domain/canonical-json.js';
import { SemWitnessError } from '../../domain/errors.js';
import { parseStrictJson } from '../../domain/strict-json.js';
import type {
  Codec,
  DecodeContext,
  EncodedCandidate,
} from '../../ports/codec.js';

export class JsonJcsCodec implements Codec {
  readonly descriptor = {
    id: 'json-jcs',
    version: '1',
    deterministic: true,
    acceptedKinds: ['json-data'],
    equivalence: 'typed-semantic',
  } as const;

  async encode(
    segment: Parameters<Codec['encode']>[0],
    context: Parameters<Codec['encode']>[1],
  ): Promise<EncodedCandidate> {
    const source = decodeUtf8(segment.content);
    const value = parseStrictJson(source, {
      maxDepth: context.policy.limits.maxDepth,
      maxItems: context.policy.limits.maxItems,
      maxStringCodeUnits: context.policy.limits.maxInputBytes,
    });
    return {
      bytes: new TextEncoder().encode(canonicalJson(value)),
    };
  }

  async decode(
    candidate: EncodedCandidate,
    context: DecodeContext,
  ): Promise<Uint8Array> {
    const value = parseStrictJson(decodeUtf8(candidate.bytes), {
      maxDepth: context.maxDepth,
      maxItems: context.maxItems,
      maxStringCodeUnits: context.maxOutputBytes,
    });
    const result = new TextEncoder().encode(canonicalJson(value));
    if (result.byteLength > context.maxOutputBytes) {
      throw new SemWitnessError(
        'DECODE_LIMIT',
        'Canonical JSON output exceeds limit',
      );
    }
    return result;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SemWitnessError(
      'FORMAT_UNSUPPORTED',
      'JSON codec requires UTF-8',
      error,
    );
  }
}
