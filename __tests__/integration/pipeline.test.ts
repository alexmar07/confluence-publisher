import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_SUMMARY_LIMIT_BYTES, run } from '../../src/index.js';

const BASE_URL = process.env.WIREMOCK_URL ?? 'http://localhost:8080';

const inputs = (over: Record<string, string> = {}): Record<string, string> => ({
  FOLDER: 'test/fixtures/docs',
  'BASE-URL': BASE_URL,
  USERNAME: 'u@acme.com',
  'API-TOKEN': 'tok',
  'SPACE-KEY': 'DOC',
  'PARENT-PAGE-ID': '2000',
  'ADD-SOURCE-FOOTER': 'false',
  ...over,
});

// `@actions/core`'s `summary` object resolves `GITHUB_STEP_SUMMARY` once, on its first use
// (`summary.filePath()` caches the path in `this._filePath` and never re-reads the
// environment variable afterwards). A fresh temp directory per test would therefore only
// ever be honoured by the first test to touch the summary; every later test would keep
// writing into that first file. The path is instead created once, here, and each test gets
// a clean slate by truncating that same file in `beforeEach` — do not move this back into
// `beforeEach` as a per-test `mkdtempSync`, it would silently reintroduce the bug.
let summaryPath: string;
let outputPath: string;

beforeAll(async () => {
  const response = await fetch(`${BASE_URL}/__admin/mappings`);
  expect(response.ok).toBe(true);
  await fetch(`${BASE_URL}/__admin/scenarios/reset`, { method: 'POST' });

  const fixedDir = mkdtempSync(join(tmpdir(), 'cdp-summary-'));
  summaryPath = join(fixedDir, 'summary');
  outputPath = join(fixedDir, 'output');
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  process.env.GITHUB_OUTPUT = outputPath;
});

beforeEach(() => {
  writeFileSync(summaryPath, '');
  writeFileSync(outputPath, '');
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

const applyInputs = (values: Record<string, string>): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[`INPUT_${key}`] = value;
};

const outputs = (): Record<string, string> => {
  const raw = readFileSync(process.env.GITHUB_OUTPUT as string, 'utf8');
  const found: Record<string, string> = {};
  for (const match of raw.matchAll(/^(.+?)<<ghadelimiter_[^\n]+\n([\s\S]*?)\nghadelimiter_[^\n]+$/gm)) {
    found[match[1] as string] = match[2] as string;
  }
  return found;
};

describe('the whole pipeline against the simulator', () => {
  it('publishes a three-level tree, counting synthetic containers apart', async () => {
    applyInputs(inputs());
    await run();
    const totals = outputs();
    expect(totals.created).toBe('5');
    expect(totals.containers).toBe('2');
    expect(totals.failed).toBe('0');
    expect(process.exitCode).toBe(0);
  });

  it('stops at the plan in dry-run, writing nothing and exiting zero', async () => {
    applyInputs(inputs({ 'DRY-RUN': 'true' }));
    await run();
    const summary = readFileSync(process.env.GITHUB_STEP_SUMMARY as string, 'utf8');
    expect(summary).toContain('dry run');
    expect(summary).toContain('would create');
    expect(outputs().created).toBe('0');
    expect(process.exitCode).toBe(0);
  });

  it('states that a Folder parent is a Folder and fails before any write', async () => {
    applyInputs(inputs({ 'PARENT-PAGE-ID': '999' }));
    await run();
    expect(process.exitCode).toBe(1);
  });

  // Page 4100 (move-descendants.json, move-old-properties.json) is indexed under the root
  // parent 4000 with source-path "test/fixtures/move-docs/a.md" and the content-hash the
  // fixture's actual title/parent/xhtml hash to. The fixture on disk only has
  // test/fixtures/move-docs/moved/a.md, so a.md is a vanished entry and moved/a.md is a fresh
  // node with the identical title and body: the pipeline must recognise the relocation instead
  // of reporting a foreign-source-path conflict and aborting.
  it('detects a source file moved to another folder and repositions the page instead of aborting', async () => {
    applyInputs(inputs({ FOLDER: 'test/fixtures/move-docs', 'PARENT-PAGE-ID': '4000' }));
    await run();
    const totals = outputs();
    expect(totals.moved).toBe('1');
    expect(totals.containers).toBe('1');
    expect(totals.created).toBe('0');
    expect(totals.failed).toBe('0');
    // The vanished entry was consumed by the move, so it must not be reported as an orphan.
    expect(totals.orphans).toBe('0');
    expect(process.exitCode).toBe(0);
  });

  // Nothing pinned that run() writes `boundForSummary`'s *result* rather than the raw
  // preview, nor that the truncation warning is emitted at all — replacing `bounded.text` with
  // `preview`, or deleting the warning block, both survived the suite. The fixture is generated
  // here rather than committed: renderPlanPreview emits one line per page carrying the page
  // title, so a handful of files with very long H1 titles overruns the 900_000-byte limit
  // without a multi-hundred-kilobyte file entering the repo.
  describe('a dry-run preview larger than the job summary limit', () => {
    // The folder input must be repository-relative (parseConfig rejects absolute paths), so the
    // generated tree lives under test/ and is removed again in afterAll.
    const folder = 'test/fixtures/oversized-preview-tmp';
    // Each title also travels in the query string of the title-search request, and the
    // WireMock simulator answers HTTP 414 somewhere between ~30_000 and ~60_000 bytes of URL.
    // Do not raise this length without re-checking that ceiling against the simulator.
    const TITLE_BYTES = 12_000;
    const FILES = 80; // 80 * ~12_060 bytes per preview line ≈ 965 kB, comfortably over the limit

    beforeAll(() => {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      for (let i = 0; i < FILES; i += 1) {
        // Titles must be unique (a repeated one would abort at the internal-duplicate preflight)
        // and free of characters that widen once URL-encoded into the title search.
        const title = `p${String(i).padStart(3, '0')}-${'a'.repeat(TITLE_BYTES)}`;
        writeFileSync(join(folder, `page-${String(i).padStart(3, '0')}.md`), `# ${title}\n\nBody.\n`);
      }
    });

    afterAll(() => {
      rmSync(folder, { recursive: true, force: true });
    });

    it('truncates the job summary to the byte limit and warns about it', async () => {
      // core.info() prints the whole ~1 MB preview and core.warning() writes the ::warning::
      // command; both go through stdout, so one spy both captures the warning and keeps the
      // preview out of the test log.
      const written: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
      try {
        applyInputs(inputs({ FOLDER: folder, 'DRY-RUN': 'true' }));
        await run();
      } finally {
        stdout.mockRestore();
      }

      const summary = readFileSync(process.env.GITHUB_STEP_SUMMARY as string, 'utf8');
      const heading = '## confluence-docs-publisher — dry run\n\n';
      expect(summary.startsWith(heading)).toBe(true);
      // The bounded text is what run() must have written: the raw preview is far larger.
      expect(Buffer.byteLength(summary.slice(heading.length), 'utf8')).toBeLessThanOrEqual(
        JOB_SUMMARY_LIMIT_BYTES,
      );
      expect(summary).toContain('Preview truncated to stay within');

      const warnings = written.filter((line) => line.startsWith('::warning::'));
      expect(warnings.join('\n')).toContain(`truncated to stay within the ${JOB_SUMMARY_LIMIT_BYTES}-byte`);

      expect(process.exitCode).toBe(0);
      // The action declares no `dry-run` output; the flag travels inside the `report` JSON.
      expect(JSON.parse(outputs().report as string)).toMatchObject({ dryRun: true });
    });
  });

  // `core.summary.write()` rejects when `GITHUB_STEP_SUMMARY` is unset, and every write
  // used to be awaited bare, so the rejection pre-empted the outputs (dry run) or the
  // `setFailed` narrative (failure epilogue). The summary is a convenience artefact: losing it
  // must change neither outcome.
  describe('a job summary that cannot be written', () => {
    // Deleting `GITHUB_STEP_SUMMARY` cannot produce the rejection here: `summary.filePath()`
    // caches the resolved path on its first use (see the note at the top of this file) and
    // never re-reads the environment afterwards, so by the time these tests run the variable
    // is no longer consulted at all. Replacing the summary *file* with a directory instead
    // makes the underlying `appendFile` fail with EISDIR — a real rejection out of
    // `summary.write()`, with nothing about `@actions/core` mocked.
    const runWithUnwritableSummary = async (body: () => Promise<void>): Promise<string[]> => {
      const written: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
      rmSync(summaryPath, { force: true });
      mkdirSync(summaryPath);
      try {
        await body();
      } finally {
        rmSync(summaryPath, { recursive: true, force: true });
        writeFileSync(summaryPath, '');
        stdout.mockRestore();
      }
      return written.filter((line) => line.startsWith('::warning::'));
    };

    it('still emits the dry-run outputs and exits zero', async () => {
      applyInputs(inputs({ 'DRY-RUN': 'true' }));
      const warnings = await runWithUnwritableSummary(() => run());
      expect(warnings.join('\n')).toContain('dry-run job summary could not be written');
      expect(outputs().created).toBe('0');
      expect(JSON.parse(outputs().report as string)).toMatchObject({ dryRun: true });
      expect(process.exitCode).toBe(0);
    });

    it('still emits the zeroed outputs and fails through setFailed on the epilogue path', async () => {
      applyInputs(inputs({ 'PARENT-PAGE-ID': '999' }));
      const warnings = await runWithUnwritableSummary(() => run());
      expect(warnings.join('\n')).toContain('failure job summary could not be written');
      const totals = outputs();
      expect(totals.created).toBe('0');
      expect(totals.failed).toBe('0');
      expect(totals.report).toBeDefined();
      expect(process.exitCode).toBe(1);
    });
  });
});

import { ConfluenceClient } from '../../src/confluence/client.js';
import { uploadAttachment } from '../../src/confluence/legacyAttachments.js';
import { updatePage } from '../../src/confluence/pages.js';
import { parseMarkdown } from '../../src/markdown/parse.js';
import { preflightTitles } from '../../src/preflight.js';
import { buildTree, flattenTree } from '../../src/tree.js';

const client = new ConfluenceClient({
  baseUrl: BASE_URL, username: 'u@acme.com', apiToken: 'tok',
  requestTimeoutMs: 10_000, maxRetries: 0,
});

describe('module-level scenarios against the simulator', () => {
  it('re-reads and retries once when the version is stale', async () => {
    await expect(
      updatePage(client, {
        pageId: '500', title: 'Contested', parentId: '2000',
        storage: '<p>x</p>', versionMessage: 'm',
      }),
    ).resolves.toMatchObject({ id: '500' });
  });

  it('blocks a title already held by a page bound to another source', async () => {
    const nodes = flattenTree(buildTree([parseMarkdown('docs/c.md', '# Contested\n', 'h1')], 'docs'));
    const { conflicts } = await preflightTitles(client, '42', nodes, new Map(), 2);
    expect(conflicts[0]).toMatchObject({ reason: 'foreign-source-path', occupantSourcePath: 'docs/altro.md' });
  });

  it('adopts a pre-existing page that carries no tracking property', async () => {
    const nodes = flattenTree(buildTree([parseMarkdown('docs/d.md', '# Adoptable\n', 'h1')], 'docs'));
    const { conflicts, adoptions } = await preflightTitles(client, '42', nodes, new Map(), 2);
    expect(conflicts).toEqual([]);
    expect(adoptions[0]).toMatchObject({ sourcePath: 'docs/d.md', page: { id: '700' } });
  });

  it('replaces an attachment byte-wise via the v1 update endpoint, not the create endpoint (AC-16)', async () => {
    // Page 800 already carries an attachment named diagram.png (attachment-replace-list.json);
    // only attachment-replace-update.json stubs the POST .../child/attachment/8001/data — the
    // plain create endpoint has no stub for page 800, so a regression back to the create-only
    // call would 404 here instead of silently passing.
    await expect(
      uploadAttachment(client, '800', 'diagram.png', new Uint8Array([1, 2, 3])),
    ).resolves.toBeUndefined();
  });
});
