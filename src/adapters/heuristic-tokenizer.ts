import { Buffer } from 'node:buffer';
import type { TokenCount, TokenizerAdapter } from '../ports/tokenizer.js';

const TOKEN_PATTERN = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]|[\r\n]+|[ \t]+/gu;

export class HeuristicTokenizer implements TokenizerAdapter {
  readonly id = 'heuristic-v1';
  readonly fingerprint = [
    'semwitness/heuristic-v1',
    'utf8-word-punctuation-whitespace',
    `node-${process.versions.node}`,
    `unicode-${process.versions.unicode}`,
  ].join(':');

  async count(bytes: Uint8Array, _mediaType: string): Promise<TokenCount> {
    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return {
        tokens: Math.ceil(bytes.byteLength / 4),
        reliability: 'heuristic',
      };
    }

    let tokens = 0;
    for (const match of source.matchAll(TOKEN_PATTERN)) {
      const value = match[0];
      if (/^[\p{L}\p{N}_]+$/u.test(value)) {
        tokens += Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
      } else if (/^[\r\n]+$/u.test(value)) {
        tokens += value.replace(/\r/gu, '').length;
      } else if (/^[ \t]+$/u.test(value)) {
        tokens += Math.max(1, Math.ceil(value.length / 8));
      } else {
        tokens += 1;
      }
    }
    return { tokens, reliability: 'heuristic' };
  }
}
