import {
  IdentityCodec,
  JsonJcsCodec,
  LogRepeatCodec,
  WhitespaceRleCodec,
} from '../src/adapters/index.js';
import { CodecRegistry } from '../src/application/codec-registry.js';
import {
  DEFAULT_POLICY,
  validatePolicy,
  type CodecPolicy,
  type PolicyRule,
} from '../src/domain/policy.js';
import type { TokenCount, TokenizerAdapter } from '../src/ports/tokenizer.js';

export class DeterministicByteTokenizer implements TokenizerAdapter {
  readonly id: string;
  readonly fingerprint: string;
  readonly #reliability: TokenCount['reliability'];

  constructor(
    id = DEFAULT_POLICY.tokenizerId,
    reliability: TokenCount['reliability'] = 'exact',
    fingerprint = `test/byte-tokenizer:${reliability}`,
  ) {
    this.id = id;
    this.fingerprint = fingerprint;
    this.#reliability = reliability;
  }

  async count(bytes: Uint8Array): Promise<TokenCount> {
    return { tokens: bytes.byteLength, reliability: this.#reliability };
  }
}

export interface PolicyOverrides {
  readonly mode?: CodecPolicy['mode'];
  readonly rules?: readonly PolicyRule[];
  readonly selection?: Partial<CodecPolicy['selection']>;
  readonly limits?: Partial<CodecPolicy['limits']>;
  readonly tokenizerId?: string;
}

export function makePolicy(overrides: PolicyOverrides = {}): CodecPolicy {
  return validatePolicy({
    apiVersion: DEFAULT_POLICY.apiVersion,
    mode: overrides.mode ?? DEFAULT_POLICY.mode,
    rules: overrides.rules ?? DEFAULT_POLICY.rules,
    selection: {
      ...DEFAULT_POLICY.selection,
      ...overrides.selection,
    },
    limits: {
      ...DEFAULT_POLICY.limits,
      ...overrides.limits,
    },
    fallback: DEFAULT_POLICY.fallback,
    tokenizerId: overrides.tokenizerId ?? DEFAULT_POLICY.tokenizerId,
    store: { ...DEFAULT_POLICY.store },
  });
}

export function createRegistry(): CodecRegistry {
  return new CodecRegistry()
    .register(new IdentityCodec())
    .register(new WhitespaceRleCodec())
    .register(new LogRepeatCodec())
    .register(new JsonJcsCodec());
}

export function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
