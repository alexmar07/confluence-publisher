import type { Outcome } from './execute.js';
import type { LeftoverPage, Plan, PlannedAction } from './plan.js';

export interface Totals {
  created: number;
  updated: number;
  moved: number;
  skipped: number;
  failed: number;
  containers: number;
  attachments: number;
  orphans: number;
  unmanaged: number;
}

export interface ReportInput {
  outcomes: readonly Outcome[];
  leftovers: readonly LeftoverPage[];
  attachmentsUploaded: number;
  orphanPolicy: 'report' | 'ignore';
  dryRun: boolean;
  baseUrl: string;
}

export function summarise(input: ReportInput): Totals {
  const totals: Totals = {
    created: 0, updated: 0, moved: 0, skipped: 0, failed: 0,
    containers: 0, attachments: input.attachmentsUploaded, orphans: 0, unmanaged: 0,
  };

  for (const outcome of input.outcomes) {
    if (outcome.kind === 'failed') {
      totals.failed += 1;
      continue;
    }
    // Synthetic containers are counted apart, so created/updated/skipped stay in one-to-one
    // correspondence with published sources. `containers` counts every non-failed synthetic
    // outcome alike — it's "container pages seen this run", not "changed this run" — because a
    // skipped container must still be counted somewhere, or totals stop summing to
    // `outcomes.length`.
    if (outcome.synthetic) {
      totals.containers += 1;
      continue;
    }
    totals[outcome.kind] += 1;
  }

  for (const leftover of input.leftovers) {
    if (leftover.category === 'orphan') totals.orphans += 1;
    else if (leftover.category === 'unmanaged') totals.unmanaged += 1;
  }

  return totals;
}

/**
 * Confluence Cloud resolves a page from its id alone through this route, without the space key,
 * which the report does not have. `/wiki/spaces/pages/{id}` is not a valid route and 404s.
 */
function pageUrl(baseUrl: string, pageId: string): string {
  return `${baseUrl}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/** Escapes the two characters that would otherwise shift or terminate a Markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** As `escapeCell`, plus `]`: inside a `[label](url)` link, an unescaped `]` closes the label early. */
function escapeLinkLabel(text: string): string {
  return escapeCell(text).replace(/\]/g, '\\]');
}

/**
 * A titled block of table rows. `heading` carries the section title, column header and
 * separator — everything that must vanish together the moment `rows` runs dry, so a
 * truncated report never shows a heading or a `|---|---|` over an empty table.
 */
interface Section {
  heading: readonly string[];
  rows: string[];
}

function buildSections(input: ReportInput): Section[] {
  const sections: Section[] = [];

  const failures = input.outcomes.filter((outcome) => outcome.kind === 'failed');
  if (failures.length > 0) {
    sections.push({
      heading: ['### Failures', '', '| source | title | status | message |', '|---|---|---|---|'],
      rows: failures.map((failure) => {
        const status = failure.error?.status ?? '—';
        const message = escapeCell(failure.error?.message ?? '');
        return `| ${escapeCell(failure.sourcePath)} | ${escapeCell(failure.title)} | ${status} | ${message} |`;
      }),
    });
  }

  if (input.orphanPolicy === 'report') {
    for (const [category, heading] of [['orphan', 'Orphan pages'], ['unmanaged', 'Unmanaged pages']] as const) {
      const entries = input.leftovers.filter((leftover) => leftover.category === category);
      if (entries.length === 0) continue;
      sections.push({
        heading: [`### ${heading}`, '', '| page | expected source-path |', '|---|---|'],
        rows: entries.map(({ entry }) =>
          `| [${escapeLinkLabel(entry.title)}](${pageUrl(input.baseUrl, entry.pageId)}) | ${escapeCell(entry.sourcePath ?? '—')} |`),
      });
    }
  }

  return sections;
}

/** Renders only the sections that still have at least one row — an emptied section contributes nothing, heading included. */
function renderSections(sections: readonly Section[]): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    if (section.rows.length === 0) continue;
    lines.push(...section.heading, ...section.rows, '');
  }
  return lines;
}

export function renderSummary(
  input: ReportInput,
  limitBytes = 900_000,
): { markdown: string; omittedRows: number } {
  const totals = summarise(input);
  // The totals header is a fixed handful of lines and can never approach a byte limit meant
  // to guard against thousands of outcome/leftover rows; it is never truncated below — only
  // the per-outcome and per-leftover tables, whose row count is unbounded, are.
  const header = [
    `## confluence-docs-publisher${input.dryRun ? ' — dry run' : ''}`,
    '',
    '| outcome | count |',
    '|---|---|',
    ...Object.entries(totals).map(([key, value]) => `| ${key} | ${value} |`),
    '',
  ];

  const sections = buildSections(input);

  let omittedRows = 0;
  const assemble = (): string => {
    const lines = [...header, ...renderSections(sections)];
    if (omittedRows > 0) {
      lines.push(`_${omittedRows} rows omitted to stay within the ${limitBytes}-byte job summary limit._`, '');
    }
    return lines.join('\n');
  };

  let markdown = assemble();
  while (Buffer.byteLength(markdown, 'utf8') > limitBytes) {
    // Drop the last data row of the last section that still has one — never a heading,
    // column header or separator, and never a row from an earlier section while a later
    // one still has rows of its own to give up first.
    const target = sections.findLast((section) => section.rows.length > 0);
    if (!target) break; // nothing left to drop; the untruncatable header is the floor.
    target.rows.pop();
    omittedRows += 1;
    markdown = assemble();
  }

  return { markdown, omittedRows };
}

/** The dry-run preview names planned creations by source path and computed title. */
export function renderPlanPreview(plan: Plan): string {
  const label: Record<PlannedAction, string> = {
    create: 'would create', update: 'would update', move: 'would move', skip: 'unchanged',
  };
  const lines: string[] = [];
  for (const scope of [false, true]) {
    const pages = plan.pages.filter((page) => page.node.synthetic === scope);
    if (pages.length === 0) continue;
    lines.push(scope ? '### Synthetic container pages' : '### File-derived pages', '');
    for (const page of pages) {
      lines.push(`- ${label[page.action]}: ${page.node.sourcePath} → "${page.node.title}"`);
    }
    lines.push('');
  }
  for (const category of ['orphan', 'unmanaged'] as const) {
    const entries = plan.leftovers.filter((leftover) => leftover.category === category);
    if (entries.length === 0) continue;
    lines.push(`### ${category}`, '');
    for (const { entry } of entries) lines.push(`- ${entry.title} (${entry.sourcePath ?? 'no source-path'})`);
    lines.push('');
  }
  return lines.join('\n');
}

export function toJsonReport(input: ReportInput): string {
  return JSON.stringify({
    dryRun: input.dryRun,
    totals: summarise(input),
    outcomes: input.outcomes,
    leftovers: input.leftovers.map(({ category, entry }) => ({
      category, pageId: entry.pageId, title: entry.title, sourcePath: entry.sourcePath,
    })),
  });
}
