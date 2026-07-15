import { SemWitnessError } from './errors.js';
import type { JsonValue } from './canonical-json.js';

export interface StrictJsonLimits {
  readonly maxDepth: number;
  readonly maxItems: number;
  readonly maxStringCodeUnits: number;
  readonly maxNumberCodeUnits: number;
}

const DEFAULT_LIMITS: StrictJsonLimits = Object.freeze({
  maxDepth: 64,
  maxItems: 100_000,
  maxStringCodeUnits: 8 * 1024 * 1024,
  maxNumberCodeUnits: 1024,
});

export function parseStrictJson(
  source: string,
  limitsInput: number | Partial<StrictJsonLimits> = DEFAULT_LIMITS,
): JsonValue {
  const limits = resolveLimits(limitsInput);
  let cursor = 0;
  let items = 0;
  const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

  const fail = (message: string): never => {
    throw new SemWitnessError(
      'FORMAT_UNSUPPORTED',
      `${message} at byte-like offset ${cursor}`,
    );
  };

  const skipWhitespace = (): void => {
    while (
      cursor < source.length &&
      isJsonWhitespace(source.charCodeAt(cursor))
    ) {
      cursor += 1;
    }
  };

  const consumeItem = (): void => {
    items += 1;
    if (items > limits.maxItems) {
      fail('JSON item limit exceeded');
    }
  };

  const parseString = (): string => {
    const start = cursor;
    if (source[cursor] !== '"') {
      return fail('Expected JSON string');
    }
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      if (cursor - start > limits.maxStringCodeUnits * 6 + 2) {
        return fail('JSON string source limit exceeded');
      }
      const character = source[cursor]!;
      if (!escaped && character === '"') {
        cursor += 1;
        try {
          const parsed: unknown = JSON.parse(source.slice(start, cursor));
          if (typeof parsed !== 'string') {
            return fail('Invalid JSON string');
          }
          if (parsed.length > limits.maxStringCodeUnits) {
            return fail('JSON string limit exceeded');
          }
          return parsed;
        } catch (error) {
          throw new SemWitnessError(
            'FORMAT_UNSUPPORTED',
            'Invalid JSON string escape',
            error,
          );
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) {
        return fail('Unescaped control character');
      }
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      }
      cursor += 1;
    }
    return fail('Unterminated JSON string');
  };

  const parseNumber = (): number => {
    let end = cursor;
    while (end < source.length && isNumberCharacter(source.charCodeAt(end))) {
      end += 1;
      if (end - cursor > limits.maxNumberCodeUnits) {
        return fail('JSON number literal limit exceeded');
      }
    }
    const literal = source.slice(cursor, end);
    const match = numberPattern.exec(literal);
    if (match === null) {
      return fail('Invalid JSON number');
    }
    cursor = end;
    const value = Number(literal);
    if (!Number.isFinite(value)) {
      return fail('JSON number exceeds finite range');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return fail('JSON integer exceeds the safe exact range');
    }
    if (!preservesDecimalValue(literal, value)) {
      return fail('JSON number loses decimal precision');
    }
    return Object.is(value, -0) ? 0 : value;
  };

  const parseValue = (depth: number): JsonValue => {
    consumeItem();
    if (depth > limits.maxDepth) {
      return fail('JSON nesting limit exceeded');
    }
    skipWhitespace();
    const character = source[cursor];
    if (character === '"') {
      return parseString();
    }
    if (character === '[') {
      cursor += 1;
      const result: JsonValue[] = [];
      skipWhitespace();
      if (source[cursor] === ']') {
        cursor += 1;
        return result;
      }
      while (cursor < source.length) {
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (source[cursor] === ']') {
          cursor += 1;
          return result;
        }
        if (source[cursor] !== ',') {
          return fail('Expected comma or closing bracket');
        }
        cursor += 1;
      }
      return fail('Unterminated JSON array');
    }
    if (character === '{') {
      cursor += 1;
      const result: Record<string, JsonValue> = Object.create(null) as Record<
        string,
        JsonValue
      >;
      const keys = new Set<string>();
      skipWhitespace();
      if (source[cursor] === '}') {
        cursor += 1;
        return result;
      }
      while (cursor < source.length) {
        skipWhitespace();
        consumeItem();
        const key = parseString();
        if (keys.has(key)) {
          return fail('Duplicate JSON key');
        }
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ':') {
          return fail('Expected colon after JSON object key');
        }
        cursor += 1;
        result[key] = parseValue(depth + 1);
        skipWhitespace();
        if (source[cursor] === '}') {
          cursor += 1;
          return result;
        }
        if (source[cursor] !== ',') {
          return fail('Expected comma or closing brace');
        }
        cursor += 1;
      }
      return fail('Unterminated JSON object');
    }
    if (source.startsWith('true', cursor)) {
      cursor += 4;
      return true;
    }
    if (source.startsWith('false', cursor)) {
      cursor += 5;
      return false;
    }
    if (source.startsWith('null', cursor)) {
      cursor += 4;
      return null;
    }
    if (
      character === '-' ||
      (character !== undefined && isAsciiDigit(character.charCodeAt(0)))
    ) {
      return parseNumber();
    }
    return fail('Unexpected JSON token');
  };

  const value = parseValue(0);
  skipWhitespace();
  if (cursor !== source.length) {
    return fail('Trailing data after JSON value');
  }
  return value;
}

function resolveLimits(
  input: number | Partial<StrictJsonLimits>,
): StrictJsonLimits {
  const candidate =
    typeof input === 'number' ? { ...DEFAULT_LIMITS, maxDepth: input } : input;
  const limits = {
    maxDepth: candidate.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxItems: candidate.maxItems ?? DEFAULT_LIMITS.maxItems,
    maxStringCodeUnits:
      candidate.maxStringCodeUnits ?? DEFAULT_LIMITS.maxStringCodeUnits,
    maxNumberCodeUnits:
      candidate.maxNumberCodeUnits ?? DEFAULT_LIMITS.maxNumberCodeUnits,
  };
  if (
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 1 ||
    limits.maxDepth > 256 ||
    !Number.isSafeInteger(limits.maxItems) ||
    limits.maxItems < 1 ||
    limits.maxItems > 1_000_000 ||
    !Number.isSafeInteger(limits.maxStringCodeUnits) ||
    limits.maxStringCodeUnits < 1 ||
    limits.maxStringCodeUnits > 128 * 1024 * 1024 ||
    !Number.isSafeInteger(limits.maxNumberCodeUnits) ||
    limits.maxNumberCodeUnits < 1 ||
    limits.maxNumberCodeUnits > 1024 * 1024
  ) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Invalid strict JSON parser limits',
    );
  }
  return limits;
}

interface NormalizedDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

function preservesDecimalValue(literal: string, value: number): boolean {
  const original = normalizeDecimal(literal);
  const canonical = normalizeDecimal(String(value));
  return (
    original !== undefined &&
    canonical !== undefined &&
    original.negative === canonical.negative &&
    original.digits === canonical.digits &&
    original.exponent === canonical.exponent
  );
}

function normalizeDecimal(literal: string): NormalizedDecimal | undefined {
  const parts = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(
    literal,
  );
  if (parts === null) {
    return undefined;
  }
  const fraction = parts[3] ?? '';
  let digits = `${parts[2]}${fraction}`.replace(/^0+/u, '');
  if (digits.length === 0) {
    return { negative: false, digits: '0', exponent: 0 };
  }
  const exponentText = parts[4] ?? '0';
  if (exponentText.replace(/^[+-]/u, '').length > 6) {
    return undefined;
  }
  let exponent = Number(exponentText) - fraction.length;
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  return { negative: parts[1] === '-', digits, exponent };
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isNumberCharacter(code: number): boolean {
  return (
    isAsciiDigit(code) ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x45 ||
    code === 0x65
  );
}
