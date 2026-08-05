import { readFile } from 'node:fs/promises';
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parseConfig, type Config } from './config.js';
import { ConfluenceClient } from './confluence/client.js';
import { uploadAttachment } from './confluence/legacyAttachments.js';
import { buildIndex, createPage, updatePage, writeProperty } from './confluence/pages.js';
import { executePlan } from './execute.js';
import { parseMarkdown } from './markdown/parse.js';
import { renderFooter, toStorage } from './markdown/storage.js';
import { buildPlan } from './plan.js';
import {
  applyAdoptions, applyMoves, detectMoves, formatConflicts, PreflightError, preflightEnvironment, preflightTitles,
} from './preflight.js';
import { renderPlanPreview, renderSummary, summarise, toJsonReport, type ReportInput } from './report.js';
import { buildTree, flattenTree, maxDepth } from './tree.js';

export const PHASE_ORDER = [
  'config', 'preflight', 'discovery', 'parse', 'scan-index', 'preflight-titles', 'plan', 'execute', 'report',
] as const;

/**
 * The order is load-bearing: the title preflight can only tell whether a same-titled page
 * belongs to this action once the source-path index exists.
 */
function phase(name: (typeof PHASE_ORDER)[number]): void {
  core.debug(`phase ${PHASE_ORDER.indexOf(name) + 1}/${PHASE_ORDER.length}: ${name}`);
}

export const INPUT_NAMES = [
  'folder', 'base-url', 'username', 'api-token', 'space-key', 'parent-page-id', 'include', 'exclude',
  'title-strategy', 'dry-run', 'fail-on-error', 'orphans', 'concurrency', 'request-timeout-ms',
  'max-retries', 'version-message', 'add-source-footer', 'mermaid-macro',
] as const;

/**
 * The GitHub job summary enforces a hard 1 MB ceiling. `renderPlanPreview` (unlike
 * `renderSummary`) has no byte bound of its own, yet the dry-run path writes it into that same
 * sink, so without a bound here a dry run over a large docs tree fails the summary write.
 * Matches `renderSummary`'s own default `limitBytes` so both writers share one real number.
 */
export const JOB_SUMMARY_LIMIT_BYTES = 900_000;

export interface BoundedText {
  text: string;
  truncated: boolean;
}

/**
 * Slices `text` to at most `maxBytes` UTF-8 bytes, guaranteeing
 * `Buffer.byteLength(result, 'utf8') <= maxBytes` for every input.
 *
 * `Buffer#toString('utf8')` would not: on a slice ending mid multi-byte sequence it substitutes
 * U+FFFD (3 bytes) for the 1–3 dangling bytes, so the re-encoded string can exceed `maxBytes`.
 * `StringDecoder#write()` returns only complete characters and holds back an incomplete trailing
 * sequence instead of substituting, so its output is always a byte prefix of the slice.
 */
function byteSafeSlice(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const slice = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return new StringDecoder('utf8').write(slice);
}

/**
 * Truncates `text` to fit within `limitBytes` (UTF-8 byte length), cutting at a line boundary
 * and appending a short notice. The notice's byte cost is reserved out of the budget up front,
 * so the result never exceeds `limitBytes` once the notice is appended.
 */
export function boundForSummary(text: string, limitBytes: number = JOB_SUMMARY_LIMIT_BYTES): BoundedText {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return { text, truncated: false };

  const notice = `\n\n_Preview truncated to stay within the ${limitBytes}-byte job summary limit._`;
  const noticeBytes = Buffer.byteLength(notice, 'utf8');
  const budget = Math.max(0, limitBytes - noticeBytes);

  const cut = byteSafeSlice(text, budget);
  const lastNewline = cut.lastIndexOf('\n');
  const trimmed = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;

  // At a limit too small for the notice itself (never production, but this function must honour
  // arbitrary limits) the notice is dropped rather than overrun the bound.
  const withNotice = noticeBytes <= limitBytes ? `${trimmed}${notice}` : trimmed;
  if (Buffer.byteLength(withNotice, 'utf8') <= limitBytes) return { text: withNotice, truncated: true };

  // Last-resort hard cut for the pathological case where the line-trimmed text plus notice
  // still overruns: `limitBytes` is never violated, whatever the input.
  return { text: byteSafeSlice(text, limitBytes), truncated: true };
}

export async function discoverSources(
  folder: string,
  include: readonly string[],
  exclude: readonly string[],
): Promise<string[]> {
  const patterns = [
    ...include.map((pattern) => `${folder}/${pattern}`),
    ...exclude.map((pattern) => `!${folder}/${pattern}`),
  ];
  const globber = await glob.create(patterns.join('\n'), { followSymbolicLinks: false });
  const cwd = `${process.cwd()}/`;
  const files = (await globber.glob())
    .map((absolute) => (absolute.startsWith(cwd) ? absolute.slice(cwd.length) : absolute))
    .filter((path) => /\.mdx?$/i.test(path));
  return files.sort();
}

async function runInner(): Promise<void> {
  const raw = Object.fromEntries(INPUT_NAMES.map((name) => [name, core.getInput(name)]));

  // Registered before any other operation — including the 'config' phase marker below, which
  // itself calls core.debug() — so that no validation error and no log line can precede the
  // credentials being masked in the runner's log renderer.
  for (const name of ['api-token', 'username'] as const) {
    const value = (raw[name] ?? '').trim();
    if (value !== '') core.setSecret(value);
  }

  phase('config');
  const config: Config = parseConfig(raw);

  const client = new ConfluenceClient({
    baseUrl: config.baseUrl,
    username: config.username,
    apiToken: config.apiToken,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    onRequest: ({ method, url, status }) => core.debug(`${method} ${url} → ${status ?? 'network error'}`),
    onRetry: ({ attempt, delayMs, status, url }) =>
      core.warning(`Retry ${attempt} in ${delayMs} ms after ${status ?? 'network error'} on ${url}`),
  });

  phase('preflight');
  const { spaceId, parentTitle } = await preflightEnvironment(client, config.spaceKey, config.parentPageId);
  core.info(`Publishing under "${parentTitle}" (page ${config.parentPageId}) in space ${config.spaceKey}.`);

  phase('discovery');
  const sources = await discoverSources(config.folder, config.include, config.exclude);
  core.info(`Discovered ${sources.length} source file(s) under "${config.folder}".`);

  phase('parse');
  const documents = await Promise.all(
    sources.map(async (sourcePath) =>
      parseMarkdown(sourcePath, await readFile(sourcePath, 'utf8'), config.titleStrategy),
    ),
  );
  for (const document of documents) {
    if (document.isEmpty) core.warning(`${document.sourcePath}: the file has no content beyond its front matter.`);
  }

  const roots = buildTree(documents, config.folder);
  const nodes = flattenTree(roots);
  const titlesBySourcePath = new Map(nodes.map((node) => [node.sourcePath, node.title]));

  const storageBySourcePath = new Map<string, { xhtml: string; attachments: { sourcePath: string; filename: string }[] }>();
  for (const node of nodes) {
    if (node.document === null) {
      storageBySourcePath.set(node.sourcePath, { xhtml: '', attachments: [] });
      continue;
    }
    const rendered = toStorage(node.document, {
      currentSourcePath: node.sourcePath,
      titlesBySourcePath,
      mermaidMacro: config.mermaidMacro,
    });
    for (const warning of rendered.warnings) core.warning(warning);
    storageBySourcePath.set(node.sourcePath, { xhtml: rendered.xhtml, attachments: rendered.attachments });
  }

  phase('scan-index');
  const index = await buildIndex(
    client,
    config.parentPageId,
    maxDepth(roots) + 1,
    config.concurrency,
    (page) =>
      core.warning(
        `Page "${page.title}" (id ${page.id}) carries a tracking property but its status is "${page.status}". Its title stays reserved and may block a write.`,
      ),
  );

  const sourceExists = (sourcePath: string): boolean => existsSync(sourcePath);

  // Pairs a page whose source vanished from disk with a fresh tree node carrying the same title
  // and body, so a moved file reads as a relocation instead of colliding with its own former
  // self on title.
  //
  // Must run and be applied before preflightTitles executes: the preflight tells
  // 'foreign-source-path' from "already ours" by comparing the occupant page's id against
  // `index.get(sourcePath)`, and until applyMoves grafts the fresh source path in, that lookup
  // misses and the occupant reads as foreign — the abort this mechanism exists to prevent. Only
  // the Docker-only integration test pins the ordering, so `npm test` will not catch a reorder.
  const moves = detectMoves(nodes, index.bySourcePath, storageBySourcePath, sourceExists);
  applyMoves(moves, index.bySourcePath);
  for (const { vanished, freshSourcePath } of moves) {
    core.info(`Detected a move: ${vanished.sourcePath} -> ${freshSourcePath} (page ${vanished.pageId}).`);
  }

  phase('preflight-titles');
  const { conflicts, adoptions } = await preflightTitles(
    client, spaceId, nodes, index.bySourcePath, config.concurrency,
  );
  if (conflicts.length > 0) {
    const message = formatConflicts(conflicts, sourceExists);
    core.setFailed(message);
    await emitFailureEpilogue(message, { orphanPolicy: config.orphans, baseUrl: config.baseUrl, dryRun: config.dryRun });
    return;
  }

  // A page found by exact title and carrying no tracking property is adopted, so that the first
  // run after the migration reuses it instead of colliding with its title.
  const unmanagedEntries = applyAdoptions(adoptions, index.bySourcePath, index.unmanaged);
  for (const { sourcePath, page } of adoptions) {
    core.info(`Adopting existing page "${page.title}" (id ${page.id}) for ${sourcePath}.`);
  }

  phase('plan');
  const plan = buildPlan({
    roots,
    storageBySourcePath,
    index: index.bySourcePath,
    unmanagedEntries,
    rootParentId: config.parentPageId,
    sourceExists,
  });
  core.debug(JSON.stringify(plan.pages.map((page) => ({ source: page.node.sourcePath, action: page.action }))));

  if (config.dryRun) {
    const preview = renderPlanPreview(plan);
    core.info(preview);
    const bounded = boundForSummary(preview);
    if (bounded.truncated) {
      core.warning(
        `The dry-run preview was truncated to stay within the ${JOB_SUMMARY_LIMIT_BYTES}-byte job summary limit.`,
      );
    }
    await writeSummary('dry-run', `## confluence-docs-publisher — dry run\n\n${bounded.text}`);
    emitOutputs({
      outcomes: [], leftovers: plan.leftovers, attachmentsUploaded: 0,
      orphanPolicy: config.orphans, dryRun: true, baseUrl: config.baseUrl,
    });
    return;
  }

  const footer = config.addSourceFooter
    ? (sourcePath: string): string =>
        renderFooter({
          serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
          repository: process.env.GITHUB_REPOSITORY ?? '',
          sha: process.env.GITHUB_SHA ?? '',
          sourcePath,
        })
    : null;

  phase('execute');
  const result = await executePlan(
    client,
    {
      plan,
      spaceId,
      versionMessage: config.versionMessage,
      concurrency: config.concurrency,
      footer,
      index: index.bySourcePath,
      knownProperties: index.propertiesByPageId,
    },
    {
      createPage,
      updatePage,
      writeProperty,
      uploadAttachment,
      readFile: async (sourcePath) => new Uint8Array(await readFile(sourcePath)),
      log: { info: (m) => core.info(m), warning: (m) => core.warning(m), debug: (m) => core.debug(m) },
    },
  );

  phase('report');
  const reportInput = {
    outcomes: result.outcomes,
    leftovers: plan.leftovers,
    attachmentsUploaded: result.attachmentsUploaded,
    orphanPolicy: config.orphans,
    dryRun: false,
    baseUrl: config.baseUrl,
  };

  const { markdown, omittedRows } = renderSummary(reportInput);
  if (omittedRows > 0) {
    core.warning(`The job summary omitted ${omittedRows} row(s) to stay within the ${JOB_SUMMARY_LIMIT_BYTES}-byte limit.`);
  }
  await writeSummary('run report', markdown);

  const totals = emitOutputs(reportInput);
  core.info(
    `${totals.created} created, ${totals.updated} updated, ${totals.moved} moved, ${totals.skipped} skipped, ${totals.failed} failed, ${totals.containers} containers, ${totals.attachments} attachments.`,
  );

  if (totals.failed > 0 && config.failOnError) {
    core.setFailed(`${totals.failed} page(s) failed to publish. See the job summary for the API messages.`);
  }
}

/**
 * `run()` is the single failure surface. `PreflightError` (missing space, wrong space, a Folder
 * where a Page is expected) is as expected a failure as a title-preflight conflict, which
 * `runInner` already reports via `core.setFailed` and a plain `return`, so both degrade the same
 * way. Anything else — a bug, a network failure `ConfluenceClient` did not retry away — is
 * re-thrown unchanged for `src/main.ts`'s `.catch(...)` backstop.
 */
export async function run(): Promise<void> {
  try {
    await runInner();
  } catch (error) {
    if (error instanceof PreflightError) {
      core.setFailed(error.message);
      await emitFailureEpilogue(error.message);
      return;
    }
    throw error;
  }
}

/**
 * The job summary is a convenience artefact, but `core.summary.write()` rejects whenever
 * `GITHUB_STEP_SUMMARY` is unset or unwritable. A bare `await` lets that rejection pre-empt what
 * follows — discarding `emitOutputs` so a successful run returns no outputs, or replacing
 * `core.setFailed` with an unhandled rejection escaping `run()`. A failed summary write must
 * never change a run's outcome nor suppress its outputs, hence the warning.
 *
 * Only the write is guarded; the markdown is buffered before the `try`. The buffer is dropped on
 * failure because `write()` only empties it after a successful flush, and a retained buffer
 * would bleed the lost summary into the next write.
 */
async function writeSummary(what: string, markdown: string): Promise<void> {
  const summary = core.summary.addRaw(markdown);
  try {
    await summary.write();
  } catch (error) {
    summary.emptyBuffer();
    core.warning(
      `The ${what} job summary could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function emitOutputs(input: Parameters<typeof summarise>[0]): ReturnType<typeof summarise> {
  const totals = summarise(input);
  for (const [key, value] of Object.entries(totals)) core.setOutput(key, value);
  core.setOutput('report', toJsonReport(input));
  return totals;
}

/**
 * Both abort paths must still set all ten declared outputs, or a caller with
 * `continue-on-error: true` reading `fromJSON(steps.publish.outputs.report)` gets `fromJSON('')`
 * and an opaque workflow error instead of a usable, all-zero report.
 *
 * `report` is optional because `run()`'s `PreflightError` catch site has no `config` in scope —
 * preflight failed before one existed. The defaults are unobservable there since `outcomes` and
 * `leftovers` are always empty: `baseUrl` is only read by `pageUrl` on a leftover row, and
 * `orphanPolicy` only gates whether such rows render at all.
 *
 * `message` is always `PreflightError#message` or `formatConflicts(...)`'s output — neither can
 * carry a credential, so writing it to the summary does not reopen the log-sink guarantee
 * `setSecret` exists to protect.
 */
async function emitFailureEpilogue(
  message: string,
  report: Pick<ReportInput, 'orphanPolicy' | 'baseUrl' | 'dryRun'> = { orphanPolicy: 'report', baseUrl: '', dryRun: false },
): Promise<void> {
  emitOutputs({
    outcomes: [], leftovers: [], attachmentsUploaded: 0,
    orphanPolicy: report.orphanPolicy, dryRun: report.dryRun, baseUrl: report.baseUrl,
  });
  await writeSummary('failure', `## confluence-docs-publisher — failed\n\n${message}`);
}
