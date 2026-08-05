import { describe, expect, it } from 'vitest';
import type { Outcome } from '../src/execute.js';
import { renderPlanPreview, renderSummary, summarise, toJsonReport } from '../src/report.js';
import type { LeftoverPage, Plan, PlannedAction, PlannedPage } from '../src/plan.js';
import type { PageNode } from '../src/tree.js';

const outcome = (over: Partial<Outcome> & Pick<Outcome, 'sourcePath' | 'kind'>): Outcome => ({
  title: over.sourcePath, synthetic: false, pageId: '1', ...over,
});

const leftover = (category: LeftoverPage['category'], pageId: string): LeftoverPage => ({
  category,
  entry: { pageId, title: `p${pageId}`, parentId: 'root', sourcePath: category === 'unmanaged' ? null : 'docs/x.md', synthetic: false, contentHash: null, attachmentHashes: {} },
});

const input = (over: Partial<Parameters<typeof summarise>[0]> = {}) => ({
  outcomes: [], leftovers: [], attachmentsUploaded: 0, orphanPolicy: 'report' as const,
  dryRun: false, baseUrl: 'https://acme.atlassian.net', ...over,
});

describe('summarise', () => {
  it('counts file-derived pages separately from synthetic containers', () => {
    const totals = summarise(input({
      outcomes: [
        outcome({ sourcePath: 'docs/a.md', kind: 'created' }),
        outcome({ sourcePath: 'docs/b.md', kind: 'skipped' }),
        outcome({ sourcePath: 'docs/sub/', kind: 'created', synthetic: true }),
      ],
    }));
    expect(totals).toMatchObject({ created: 1, skipped: 1, containers: 1 });
  });

  it('counts synthetic failures in the failed total as well', () => {
    const totals = summarise(input({
      outcomes: [outcome({ sourcePath: 'docs/sub/', kind: 'failed', synthetic: true })],
    }));
    expect(totals).toMatchObject({ failed: 1, containers: 0 });
  });

  it('counts orphans and unmanaged pages but never the excluded ones', () => {
    const totals = summarise(input({
      leftovers: [leftover('orphan', '1'), leftover('unmanaged', '2'), leftover('excluded', '3')],
    }));
    expect(totals).toMatchObject({ orphans: 1, unmanaged: 1 });
  });

  it('counts a skipped synthetic container too', () => {
    // A skipped container (an unchanged README/folder page) must land somewhere, or a
    // stable tree of ten containers reports `containers: 0` every run and the totals stop
    // summing to outcomes.length. It counts as a container "seen", not as a file-derived
    // skip, so `skipped` itself must stay at 0.
    const totals = summarise(input({
      outcomes: [outcome({ sourcePath: 'docs/sub/', kind: 'skipped', synthetic: true })],
    }));
    expect(totals).toMatchObject({ containers: 1, skipped: 0 });
  });
});

describe('renderSummary', () => {
  it('renders a totals table and a failure table carrying the API message', () => {
    const markdown = renderSummary(input({
      outcomes: [outcome({ sourcePath: 'docs/a.md', kind: 'failed', pageId: null, error: { status: 400, message: 'Invalid XHTML' } })],
    })).markdown;
    expect(markdown).toContain('| created |');
    expect(markdown).toContain('docs/a.md');
    expect(markdown).toContain('400');
    expect(markdown).toContain('Invalid XHTML');
  });

  it('lists orphan and unmanaged pages with a link to the page', () => {
    const markdown = renderSummary(input({ leftovers: [leftover('orphan', '55')] })).markdown;
    expect(markdown).toContain('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=55');
  });

  it('suppresses both reported categories when the policy is ignore', () => {
    const markdown = renderSummary(input({
      leftovers: [leftover('orphan', '1'), leftover('unmanaged', '2')], orphanPolicy: 'ignore',
    })).markdown;
    expect(markdown).not.toContain('Orphan');
    expect(markdown).not.toContain('Unmanaged');
  });

  it('never lists excluded pages', () => {
    const markdown = renderSummary(input({ leftovers: [leftover('excluded', '9')] })).markdown;
    expect(markdown).not.toContain('p9');
  });

  it('truncates beyond the byte limit and declares how many rows were omitted', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      outcome({ sourcePath: `docs/file-${i}.md`, kind: 'failed', error: { status: 500, message: 'x'.repeat(200) } }));
    const { markdown, omittedRows } = renderSummary(input({ outcomes: many }), 4096);
    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThanOrEqual(4096);
    expect(omittedRows).toBeGreaterThan(0);
    expect(markdown).toContain(`${omittedRows} rows omitted`);
  });

  it('drops whole data rows and never leaves a headless table', () => {
    const many = input({
      outcomes: Array.from({ length: 5 }, (_, i) =>
        outcome({ sourcePath: `docs/f${i}.md`, kind: 'failed', error: { status: 500, message: `oops${i}` } })),
    });

    // Tight enough to force some rows out, loose enough that the section survives with one
    // data row left: the heading, column header and separator must all still be present.
    const partial = renderSummary(many, 400);
    expect(partial.omittedRows).toBe(4);
    expect(partial.markdown).toContain('### Failures');
    expect(partial.markdown).toContain('| source | title | status | message |');
    expect(partial.markdown).toContain('|---|---|---|---|');
    expect(partial.markdown.match(/\| docs\/f\d\.md \|/g)).toHaveLength(1);

    // Tight enough that every data row is gone: the heading and separator must vanish with
    // them rather than being left dangling over an empty table.
    const emptied = renderSummary(many, 300);
    expect(emptied.omittedRows).toBe(5);
    expect(emptied.markdown).not.toContain('### Failures');
    expect(emptied.markdown).not.toContain('|---|---|---|---|');
  });

  it('counts only data rows as omitted, and drains the later section before the earlier one', () => {
    const scenario = input({
      outcomes: [outcome({ sourcePath: 'docs/a.md', kind: 'failed', error: { status: 500, message: 'oops' } })],
      leftovers: [leftover('orphan', '1'), leftover('orphan', '2'), leftover('orphan', '3')],
    });

    const { markdown, omittedRows } = renderSummary(scenario, 620);

    // Exactly one data row dropped — the orphan section's last row (p3) — never the
    // blank line, heading, column header or separator that a raw-line count would also tally.
    expect(omittedRows).toBe(1);
    expect(markdown).toContain(`${omittedRows} rows omitted`);
    expect(markdown).toContain('### Failures');
    expect(markdown).toContain('docs/a.md');
    expect(markdown).toContain('### Orphan pages');
    expect(markdown).toContain('[p1]');
    expect(markdown).toContain('[p2]');
    expect(markdown).not.toContain('[p3]');
  });

  it('escapes a pipe in a failure title or source path so it does not shift the table columns', () => {
    const markdown = renderSummary(input({
      outcomes: [outcome({
        sourcePath: 'docs/a.md', title: 'Setup | Configuration', kind: 'failed',
        error: { status: 400, message: 'bad | input' },
      })],
    })).markdown;
    expect(markdown).toContain('Setup \\| Configuration');
    expect(markdown).toContain('bad \\| input');
  });

  it('escapes a closing bracket in a leftover title so it does not break the Markdown link', () => {
    const withBracket: LeftoverPage = {
      category: 'orphan',
      entry: { pageId: '7', title: 'Weird]Title', parentId: 'root', sourcePath: 'docs/x.md', synthetic: false, contentHash: null, attachmentHashes: {} },
    };
    const markdown = renderSummary(input({ leftovers: [withBracket] })).markdown;
    expect(markdown).toContain('[Weird\\]Title](https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=7)');
  });
});

describe('toJsonReport', () => {
  it('emits parseable json carrying totals, outcomes and leftovers', () => {
    const parsed = JSON.parse(toJsonReport(input({
      outcomes: [outcome({ sourcePath: 'docs/a.md', kind: 'created' })],
      leftovers: [leftover('orphan', '1')],
    }))) as Record<string, unknown>;
    expect(parsed.totals).toMatchObject({ created: 1 });
    expect(Array.isArray(parsed.outcomes)).toBe(true);
    expect(Array.isArray(parsed.leftovers)).toBe(true);
  });

  it('includes excluded pages in the json even though they are not summarised', () => {
    const parsed = JSON.parse(toJsonReport(input({ leftovers: [leftover('excluded', '3')] }))) as { leftovers: unknown[] };
    expect(parsed.leftovers).toHaveLength(1);
  });
});

// renderPlanPreview renders the dry-run preview an operator reads to decide whether to
// promote a run; covered here on the actual rendered text: both sections, all four action
// labels, the leftover sections, and the null-sourcePath fallback.

const node = (over: Partial<PageNode> & Pick<PageNode, 'sourcePath'>): PageNode => ({
  synthetic: false, title: over.sourcePath, document: null, children: [], ...over,
});

const plannedPage = (over: Partial<PlannedPage> & Pick<PlannedPage, 'node' | 'action'>): PlannedPage => ({
  pageId: null, storage: '', parentSourcePath: null, expectedParentId: null, contentHash: 'h', attachments: [], ...over,
});

describe('renderPlanPreview', () => {
  it('separates file-derived pages from synthetic containers and labels every action', () => {
    const plan: Plan = {
      pages: [
        plannedPage({ node: node({ sourcePath: 'docs/a.md', title: 'A' }), action: 'create' }),
        plannedPage({ node: node({ sourcePath: 'docs/b.md', title: 'B' }), action: 'update' }),
        plannedPage({ node: node({ sourcePath: 'docs/c.md', title: 'C' }), action: 'move' }),
        plannedPage({ node: node({ sourcePath: 'docs/d.md', title: 'D' }), action: 'skip' }),
        plannedPage({ node: node({ sourcePath: 'docs/sub/', title: 'Sub', synthetic: true }), action: 'create' }),
      ],
      leftovers: [],
    };
    const text = renderPlanPreview(plan);

    expect(text).toContain('### File-derived pages');
    expect(text).toContain('### Synthetic container pages');
    expect(text).toContain('would create: docs/a.md → "A"');
    expect(text).toContain('would update: docs/b.md → "B"');
    expect(text).toContain('would move: docs/c.md → "C"');
    expect(text).toContain('unchanged: docs/d.md → "D"');
    expect(text).toContain('would create: docs/sub/ → "Sub"');

    expect(text.indexOf('### File-derived pages')).toBeLessThan(text.indexOf('### Synthetic container pages'));
  });

  it('omits a section entirely when it has no pages', () => {
    const plan: Plan = {
      pages: [plannedPage({ node: node({ sourcePath: 'docs/a.md', title: 'A' }), action: 'create' })],
      leftovers: [],
    };
    const text = renderPlanPreview(plan);
    expect(text).toContain('### File-derived pages');
    expect(text).not.toContain('### Synthetic container pages');
  });

  it('lists orphan and unmanaged leftovers, falling back to "no source-path" when absent', () => {
    const plan: Plan = { pages: [], leftovers: [leftover('orphan', '1'), leftover('unmanaged', '2')] };
    const text = renderPlanPreview(plan);
    expect(text).toContain('### orphan');
    expect(text).toContain('### unmanaged');
    expect(text).toContain('p1 (docs/x.md)');
    expect(text).toContain('p2 (no source-path)');
  });

  it('every PlannedAction maps to a distinct, non-empty label', () => {
    const actions: PlannedAction[] = ['create', 'update', 'move', 'skip'];
    const plan: Plan = {
      pages: actions.map((action, i) => plannedPage({ node: node({ sourcePath: `docs/${i}.md`, title: `T${i}` }), action })),
      leftovers: [],
    };
    const text = renderPlanPreview(plan);
    const labels = ['would create', 'would update', 'would move', 'unchanged'];
    for (const label of labels) expect(text).toContain(label);
  });
});
