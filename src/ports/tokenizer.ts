export interface TokenCount {
  readonly tokens: number;
  readonly reliability: 'exact' | 'heuristic';
}

export interface TokenizerAdapter {
  readonly id: string;
  readonly fingerprint: string;
  count(bytes: Uint8Array, mediaType: string): Promise<TokenCount>;
}

export const SAFE_TOKENIZER_FINGERPRINT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;

export function isTokenCount(value: unknown): value is TokenCount {
  return (
    value !== null &&
    typeof value === 'object' &&
    'tokens' in value &&
    Number.isSafeInteger(value.tokens) &&
    (value.tokens as number) >= 0 &&
    'reliability' in value &&
    (value.reliability === 'exact' || value.reliability === 'heuristic')
  );
}

export function isSafeTokenizerFingerprint(value: unknown): value is string {
  return (
    typeof value === 'string' && SAFE_TOKENIZER_FINGERPRINT_PATTERN.test(value)
  );
}
