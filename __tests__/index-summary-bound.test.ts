import { describe, expect, it } from 'vitest';
import { boundForSummary, JOB_SUMMARY_LIMIT_BYTES } from '../src/index.js';

// `renderPlanPreview` (src/report.ts) has no byte bound of its own, unlike `renderSummary`.
// The dry-run path writes its output into the same GitHub job summary sink, which enforces
// a hard 1 MB ceiling. `boundForSummary` is the caller-side guard that closes that gap
// without touching src/report.ts.
describe('boundForSummary', () => {
  it('returns the text unchanged, and reports no truncation, when it is under the limit', () => {
    const result = boundForSummary('short preview', 1_000);
    expect(result).toEqual({ text: 'short preview', truncated: false });
  });

  it('truncates text that exceeds the limit and reports truncation', () => {
    const long = Array.from({ length: 200 }, (_, i) => `- line ${i}`).join('\n');
    const result = boundForSummary(long, 200);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(200);
  });

  it('never exceeds limitBytes even counting the appended truncation notice', () => {
    const long = 'x'.repeat(10_000);
    for (const limit of [50, 120, 500, 4_096]) {
      const result = boundForSummary(long, limit);
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(limit);
    }
  });

  it('cuts only at a line boundary, never mid-line', () => {
    const long = Array.from({ length: 50 }, (_, i) => `row-${i}-${'y'.repeat(20)}`).join('\n');
    const result = boundForSummary(long, 300);
    expect(result.truncated).toBe(true);
    // Every surviving content line (i.e. not the appended notice) must be one of the
    // original, complete lines — never a partial row cut off mid-character.
    const originalLines = new Set(long.split('\n'));
    const noticeIndex = result.text.indexOf('\n\n_Preview truncated');
    const survivingText = noticeIndex >= 0 ? result.text.slice(0, noticeIndex) : result.text;
    for (const line of survivingText.split('\n')) {
      expect(originalLines.has(line)).toBe(true);
    }
  });

  it('mentions the real byte limit in the notice rather than a rounded "1 MB" figure', () => {
    const long = 'x'.repeat(10_000);
    const result = boundForSummary(long, 500);
    expect(result.text).toContain('500-byte');
  });

  it('defaults to the same limit renderSummary uses, so both summary writers share one ceiling', () => {
    expect(JOB_SUMMARY_LIMIT_BYTES).toBe(900_000);
  });

  // Regression: a raw `Buffer#toString('utf8')` on a slice that ends mid multi-byte
  // sequence substitutes U+FFFD (3 bytes) for the dangling bytes, which can be *longer*
  // than the bytes it replaced — so the hard-cut fallback could overrun limitBytes on
  // non-ASCII input even though every ASCII-only test above passed. '€' is 3 bytes in
  // UTF-8 and has no newlines, so the line-boundary trim never engages and the byte-exact
  // cut itself is what's under test.
  it('never exceeds limitBytes on multi-byte content, even when the cut lands mid-character', () => {
    const long = '€'.repeat(2_000);
    for (const limit of [10, 50, 100, 101, 200, 500, 4_096]) {
      const result = boundForSummary(long, limit);
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(limit);
    }
  });
});
