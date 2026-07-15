import { assertWellFormedUnicode } from './unicode.js';

/**
 * Deliberately small surface normalization for exact configured aliases.
 * NFKC intentionally folds Unicode compatibility forms (for example fullwidth
 * punctuation and circled digits). It otherwise performs no semantic rewrite.
 */
export function canonicalIntentAliasText(source: string): string {
  assertWellFormedUnicode(source, 'Intent alias');
  return source
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\t\n\r ]+/gu, ' ')
    .trim();
}

export function canonicalIntentLocale(locale: string): string {
  assertWellFormedUnicode(locale, 'Intent locale');
  return locale.toLowerCase();
}
