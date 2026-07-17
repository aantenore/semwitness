import type { JsonValue } from '../../domain/canonical-json.js';
import type {
  CompactResponseRenderer,
  CompactResponseRendererContext,
} from '../renderer.js';

export const CHANGE_REPORT_MARKDOWN_RENDERER_ARTIFACT =
  'sha256:35931e5fd8e46a37db2015dba46dd26a438040c16447f18c5dc727aa6dac7f4e' as const;

const STATUS_LABELS = Object.freeze({
  ok: 'Completed',
  warn: 'Completed with warnings',
  fail: 'Failed',
});

const CHANGE_LABELS = Object.freeze({
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
});

const VERIFICATION_LABELS = Object.freeze({
  P: 'Passed',
  F: 'Failed',
  S: 'Skipped',
});

interface ChangeReportCandidate {
  readonly s: keyof typeof STATUS_LABELS;
  readonly m: string;
  readonly c: readonly (readonly [
    keyof typeof CHANGE_LABELS,
    string,
    string,
  ])[];
  readonly v: readonly (readonly [
    keyof typeof VERIFICATION_LABELS,
    string,
    string,
  ])[];
  readonly w: readonly string[];
}

export function createChangeReportMarkdownRenderer(): CompactResponseRenderer {
  return Object.freeze({
    id: 'change-report-markdown',
    version: '1',
    artifactDigest: CHANGE_REPORT_MARKDOWN_RENDERER_ARTIFACT,
    outputMediaType: 'text/markdown',
    locales: Object.freeze(['en']),
    render(
      candidate: JsonValue,
      context: CompactResponseRendererContext,
    ): string {
      if (context.signal.aborted) throw new Error('render_aborted');
      const report = assertChangeReportCandidate(candidate);
      const lines = [
        '# Change report',
        '',
        `Status: ${STATUS_LABELS[report.s]}`,
        '',
        escapeMarkdownText(report.m),
        '',
        '## Changes',
        '',
        ...renderChanges(report.c),
        '',
        '## Verification',
        '',
        ...renderVerification(report.v),
        '',
        '## Warnings',
        '',
        ...renderWarnings(report.w),
        '',
      ];
      return lines.join('\n');
    },
  });
}

function renderChanges(changes: ChangeReportCandidate['c']): readonly string[] {
  if (changes.length === 0) return ['- None.'];
  return changes.map(
    ([kind, path, description]) =>
      `- ${CHANGE_LABELS[kind]} ${codeSpan(path)}: ${escapeMarkdownText(description)}`,
  );
}

function renderVerification(
  verifications: ChangeReportCandidate['v'],
): readonly string[] {
  if (verifications.length === 0) return ['- None.'];
  return verifications.map(
    ([status, check, evidence]) =>
      `- ${VERIFICATION_LABELS[status]} ${escapeMarkdownText(check)}: ${escapeMarkdownText(evidence)}`,
  );
}

function renderWarnings(warnings: readonly string[]): readonly string[] {
  if (warnings.length === 0) return ['- None.'];
  return warnings.map((warning) => `- ${escapeMarkdownText(warning)}`);
}

function escapeMarkdownText(value: string): string {
  return replaceControlCharacters(value, '\uFFFD', true)
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/([\\`*_[\]{}()<>#+\-.!|])/gu, '\\$1');
}

function codeSpan(value: string): string {
  const flattened = replaceControlCharacters(value, ' ', false)
    .replace(/\s+/gu, ' ')
    .trim();
  const longestRun = Math.max(
    0,
    ...[...flattened.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = '`'.repeat(longestRun + 1);
  const padding =
    flattened.startsWith('`') || flattened.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${flattened}${padding}${fence}`;
}

function replaceControlCharacters(
  value: string,
  replacement: string,
  preserveTextWhitespace: boolean,
): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const textWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    result +=
      (code <= 0x1f && (!preserveTextWhitespace || !textWhitespace)) ||
      code === 0x7f
        ? replacement
        : character;
  }
  return result;
}

function assertChangeReportCandidate(value: JsonValue): ChangeReportCandidate {
  if (!isObject(value)) throw new TypeError('invalid_change_report');
  const status = value.s;
  const summary = value.m;
  const changes = value.c;
  const verifications = value.v;
  const warnings = value.w;
  if (
    !isKeyOf(status, STATUS_LABELS) ||
    typeof summary !== 'string' ||
    !Array.isArray(changes) ||
    !changes.every(isChange) ||
    !Array.isArray(verifications) ||
    !verifications.every(isVerification) ||
    !Array.isArray(warnings) ||
    !warnings.every((item) => typeof item === 'string')
  ) {
    throw new TypeError('invalid_change_report');
  }
  return {
    s: status,
    m: summary,
    c: changes,
    v: verifications,
    w: warnings,
  };
}

function isChange(
  value: JsonValue,
): value is readonly [keyof typeof CHANGE_LABELS, string, string] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isKeyOf(value[0], CHANGE_LABELS) &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string'
  );
}

function isVerification(
  value: JsonValue,
): value is readonly [keyof typeof VERIFICATION_LABELS, string, string] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isKeyOf(value[0], VERIFICATION_LABELS) &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string'
  );
}

function isObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKeyOf<Value extends object>(
  value: JsonValue | undefined,
  record: Value,
): value is Extract<keyof Value, string> {
  return typeof value === 'string' && Object.hasOwn(record, value);
}
