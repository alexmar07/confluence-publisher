import { beforeEach, describe, expect, it, vi } from 'vitest';

// Neither abort path emitted any output or wrote anything to the job summary. A caller using
// `continue-on-error: true` plus `fromJSON(steps.publish.outputs.report)` would get
// `fromJSON('')` and an opaque workflow error on either abort. This drives both abort paths —
// the title-conflict abort inside runInner, and the PreflightError abort in run()'s catch —
// with the network-touching modules stubbed out, and asserts that every numeric output is '0'
// (never unset/empty), that `report` is valid JSON, and that the job summary carries the
// failure text.
//
// `@actions/glob` is stubbed to discover zero source files, so discoverSources, buildTree
// and the storage-rendering loop all run for real over an empty document set; only the
// network-calling functions (preflightEnvironment, preflightTitles, buildIndex) are stubbed.

const rawInputs: Record<string, string> = {
  folder: 'docs',
  'base-url': 'https://example.atlassian.net',
  username: 'alice@example.com',
  'api-token': 'super-secret-token',
  'space-key': 'DOC',
  'parent-page-id': '123',
};

const setOutputCalls: [string, string][] = [];

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => rawInputs[name] ?? ''),
  setSecret: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  // Mirrors @actions/core's own toCommandValue: setOutput's real implementation stringifies
  // whatever it is given, so a numeric total (e.g. `created: 0`) is written as the string "0".
  setOutput: vi.fn((name: string, value: unknown) => {
    setOutputCalls.push([name, typeof value === 'string' ? value : String(value)]);
  }),
  summary: {
    addRaw: vi.fn((text: string) => ({
      write: vi.fn(() => {
        summaryText = text;
        return Promise.resolve();
      }),
    })),
  },
}));

vi.mock('@actions/glob', () => ({
  create: vi.fn(() => Promise.resolve({ glob: vi.fn(() => Promise.resolve([])) })),
}));

vi.mock('../src/confluence/pages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/confluence/pages.js')>();
  return {
    ...actual,
    buildIndex: vi.fn(() =>
      Promise.resolve({ bySourcePath: new Map(), unmanaged: [], propertiesByPageId: new Map() }),
    ),
  };
});

let preflightEnvironmentImpl: () => Promise<{ spaceId: string; parentTitle: string }>;
let preflightTitlesImpl: () => Promise<{ conflicts: unknown[]; adoptions: unknown[] }>;

vi.mock('../src/preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/preflight.js')>();
  return {
    ...actual,
    preflightEnvironment: vi.fn(() => preflightEnvironmentImpl()),
    preflightTitles: vi.fn(() => preflightTitlesImpl()),
  };
});

let summaryText = '';

import * as core from '@actions/core';
import { run } from '../src/index.js';
import { PreflightError } from '../src/preflight.js';

const outputs = (): Record<string, string> => Object.fromEntries(setOutputCalls);

describe('failure epilogue (I2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOutputCalls.length = 0;
    summaryText = '';
    rawInputs['dry-run'] = '';
    preflightEnvironmentImpl = () => Promise.resolve({ spaceId: 'space-1', parentTitle: 'Root' });
    preflightTitlesImpl = () => Promise.resolve({ conflicts: [], adoptions: [] });
  });

  it('emits zeroed outputs and a job summary on the title-conflict abort', async () => {
    preflightTitlesImpl = () =>
      Promise.resolve({
        conflicts: [
          {
            title: 'Dup', sources: ['a.md', 'b.md'], occupantPageId: null,
            occupantStatus: null, occupantSourcePath: null, reason: 'internal-duplicate',
          },
        ],
        adoptions: [],
      });

    await run();

    const totals = outputs();
    expect(totals.created).toBe('0');
    expect(totals.updated).toBe('0');
    expect(totals.moved).toBe('0');
    expect(totals.skipped).toBe('0');
    expect(totals.failed).toBe('0');
    expect(totals.containers).toBe('0');
    expect(totals.attachments).toBe('0');
    expect(totals.orphans).toBe('0');
    expect(totals.unmanaged).toBe('0');
    expect(() => { JSON.parse(totals.report as string); }).not.toThrow();
    expect(vi.mocked(core.setFailed)).toHaveBeenCalled();
    expect(summaryText.length).toBeGreaterThan(0);
    expect(summaryText).toContain('Dup');
  });

  // `emitFailureEpilogue` used to hard-code `dryRun: false`. A run invoked with
  // `dry-run: true` that aborts on a title conflict must still report `dry-run: true` in its
  // output contract — a consuming workflow branching on that output would otherwise take the
  // wrong branch.
  it('emits dry-run: true on the title-conflict abort when the run was invoked with dry-run: true', async () => {
    rawInputs['dry-run'] = 'true';
    preflightTitlesImpl = () =>
      Promise.resolve({
        conflicts: [
          {
            title: 'Dup', sources: ['a.md', 'b.md'], occupantPageId: null,
            occupantStatus: null, occupantSourcePath: null, reason: 'internal-duplicate',
          },
        ],
        adoptions: [],
      });

    await run();

    const report: { dryRun: boolean } = JSON.parse(outputs().report as string) as { dryRun: boolean };
    expect(report.dryRun).toBe(true);
  });

  it('emits zeroed outputs and a job summary on the PreflightError abort', async () => {
    preflightEnvironmentImpl = () => Promise.reject(new PreflightError('space "DOC" does not exist.'));

    await run();

    const totals = outputs();
    expect(totals.created).toBe('0');
    expect(totals.updated).toBe('0');
    expect(totals.moved).toBe('0');
    expect(totals.skipped).toBe('0');
    expect(totals.failed).toBe('0');
    expect(totals.containers).toBe('0');
    expect(totals.attachments).toBe('0');
    expect(totals.orphans).toBe('0');
    expect(totals.unmanaged).toBe('0');
    expect(() => { JSON.parse(totals.report as string); }).not.toThrow();
    expect(vi.mocked(core.setFailed)).toHaveBeenCalledWith('space "DOC" does not exist.');
    expect(summaryText.length).toBeGreaterThan(0);
    expect(summaryText).toContain('space "DOC" does not exist.');
  });
});
