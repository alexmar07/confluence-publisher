import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { lines, parseConfig } from '../src/config.js';
import { INPUT_NAMES, PHASE_ORDER } from '../src/index.js';
import { summarise } from '../src/report.js';

interface ActionInput {
  required?: boolean;
  default?: string;
  description?: string;
}

interface ActionMetadata {
  inputs: Record<string, ActionInput>;
  outputs: Record<string, unknown>;
  runs: { using: string; main: string };
}

async function readAction(): Promise<ActionMetadata> {
  const text = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
  return parse(text) as ActionMetadata;
}

describe('phase order', () => {
  it('builds the index before the title preflight, as R2 requires', () => {
    expect(PHASE_ORDER.indexOf('scan-index')).toBeLessThan(PHASE_ORDER.indexOf('preflight-titles'));
  });

  it('stops at the plan phase in dry-run, before execute', () => {
    expect(PHASE_ORDER.indexOf('plan')).toBeLessThan(PHASE_ORDER.indexOf('execute'));
  });

  it('matches the sequence declared in the spec', () => {
    expect([...PHASE_ORDER]).toEqual([
      'config', 'preflight', 'discovery', 'parse', 'scan-index', 'preflight-titles', 'plan', 'execute', 'report',
    ]);
  });
});

describe('action metadata', () => {
  it('is valid YAML', async () => {
    const text = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
    expect(() => {
      parse(text);
    }).not.toThrow();
  });

  it('declares the node24 runtime and the bundled entrypoint', async () => {
    const action = await readAction();
    expect(action.runs.using).toBe('node24');
    expect(action.runs.main).toBe('dist/index.js');
  });

  it('declares exactly the inputs that src/index.ts actually reads', async () => {
    const action = await readAction();
    expect(Object.keys(action.inputs).sort()).toEqual([...INPUT_NAMES].sort());
  });

  it('declares every output the action emits — one per Totals key plus report', async () => {
    const action = await readAction();
    const totals = summarise({
      outcomes: [],
      leftovers: [],
      attachmentsUploaded: 0,
      orphanPolicy: 'report',
      dryRun: false,
      baseUrl: '',
    });
    const expectedOutputs = [...Object.keys(totals), 'report'];
    expect(Object.keys(action.outputs).sort()).toEqual(expectedOutputs.sort());
  });

  it('bundles from src/main.ts, so importing src/index.ts never runs the action', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toContain('src/main.ts');
    expect(pkg.scripts.build).toContain('dist/package.json');

    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^run\(\)/m);
  });

  it('carries no branch, tag or event logic anywhere in src (R12)', async () => {
    const { readdir } = await import('node:fs/promises');
    const walk = async (dir: URL): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
        if (entry.isDirectory()) files.push(...(await walk(child)));
        else if (entry.name.endsWith('.ts')) files.push(await readFile(child, 'utf8'));
      }
      return files;
    };
    const sources = await walk(new URL('../src/', import.meta.url));
    for (const source of sources) {
      expect(source).not.toMatch(/github\.ref|GITHUB_REF|event_name|GITHUB_EVENT_NAME/);
    }
  });
});

// Neither test above pins a default *value*, nor that action.yml's defaults agree with
// src/config.ts's fallbacks. Both matter independently: action.yml's default is what a GitHub
// runner injects as INPUT_*; src/config.ts's fallback is what applies when the input arrives
// empty, as it does under `act`, under direct `node dist/index.js` invocation, and for any
// composite caller passing "". A drift between the two means the action behaves differently on
// a GitHub runner than in every local and acceptance harness.
describe('action.yml defaults (spec §6)', () => {
  // Copied verbatim from spec §6. version-message is the one deliberate exception: it keeps the
  // English default "Updated by GitHub Actions" for a publicly published action rather than
  // adopt §6's "Aggiornato da GitHub Actions". Every other row matches §6 exactly.
  const SPEC_DEFAULTS: Record<string, string> = {
    include: '**/*.md',
    exclude: '',
    'title-strategy': 'h1',
    'dry-run': 'false',
    'fail-on-error': 'true',
    orphans: 'report',
    concurrency: '4',
    'request-timeout-ms': '30000',
    'max-retries': '5',
    'version-message': 'Updated by GitHub Actions',
    'add-source-footer': 'true',
    'mermaid-macro': 'code',
  };

  it("declares exactly §6's default value for every optional input", async () => {
    const action = await readAction();
    for (const [name, expected] of Object.entries(SPEC_DEFAULTS)) {
      expect(action.inputs[name]?.default, `action.yml input "${name}"`).toBe(expected);
    }
  });

  // The values above are pinned against the spec — that is the whole point of the literal — but
  // nothing pinned its *membership*. This side is pinned against action.yml instead, in both
  // directions, so a new optional input with a default cannot ship unpinned and a stale row
  // cannot linger.
  it('covers exactly the optional inputs action.yml declares a default for', async () => {
    const action = await readAction();
    const withDefault = Object.entries(action.inputs)
      .filter(([, input]) => input.default !== undefined)
      .map(([name]) => name);
    expect(withDefault.sort()).toEqual(Object.keys(SPEC_DEFAULTS).sort());
  });

  it('parseConfig, with every optional input empty, yields exactly the values action.yml declares', async () => {
    const action = await readAction();
    const actionDefault = (name: string): string => {
      const value = action.inputs[name]?.default;
      if (value === undefined) throw new Error(`action.yml declares no default for "${name}"`);
      return value;
    };

    const raw: Record<string, string> = {
      folder: 'docs',
      'base-url': 'https://example.atlassian.net',
      username: 'user@example.com',
      'api-token': 'token',
      'space-key': 'DOC',
      'parent-page-id': '123',
    };
    for (const name of Object.keys(SPEC_DEFAULTS)) raw[name] = '';

    const config = parseConfig(raw);

    // Every other row here compares against actionDefault(...); exclude used to hardcode [], so
    // a change to action.yml's default would have left the row passing while the two sides
    // diverged. It is derived instead through the very transformation parseConfig applies to it
    // — `lines()`, imported from src/config.ts rather than re-implemented here, so any change to
    // it (including to its fallback arm) reaches this row.
    expect(config.include).toEqual([actionDefault('include')]);
    expect(config.exclude).toEqual(lines({ exclude: actionDefault('exclude') }, 'exclude', []));
    expect(config.titleStrategy).toBe(actionDefault('title-strategy'));
    expect(config.dryRun).toBe(actionDefault('dry-run') === 'true');
    expect(config.failOnError).toBe(actionDefault('fail-on-error') === 'true');
    expect(config.orphans).toBe(actionDefault('orphans'));
    expect(config.concurrency).toBe(Number(actionDefault('concurrency')));
    expect(config.requestTimeoutMs).toBe(Number(actionDefault('request-timeout-ms')));
    expect(config.maxRetries).toBe(Number(actionDefault('max-retries')));
    expect(config.versionMessage).toBe(actionDefault('version-message'));
    expect(config.addSourceFooter).toBe(actionDefault('add-source-footer') === 'true');
    expect(config.mermaidMacro).toBe(actionDefault('mermaid-macro'));
  });
});
