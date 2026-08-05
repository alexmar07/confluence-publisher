import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown/parse.js';
import { buildTree } from '../src/tree.js';
import {
  attachmentHashKey,
  buildPlan,
  computeContentHash,
  PROPERTY_KEYS,
  type IndexEntry,
} from '../src/plan.js';

const doc = (path: string) => parseMarkdown(path, `# ${path}\n`, 'h1');

const entry = (over: Partial<IndexEntry> & Pick<IndexEntry, 'pageId'>): IndexEntry => ({
  title: 'x',
  parentId: 'root',
  sourcePath: null,
  synthetic: false,
  contentHash: null,
  attachmentHashes: {},
  ...over,
});

describe('computeContentHash', () => {
  it('is stable for identical inputs', () => {
    expect(computeContentHash('T', 'p1', '<p>x</p>')).toBe(computeContentHash('T', 'p1', '<p>x</p>'));
  });

  it('changes when the title changes', () => {
    expect(computeContentHash('T', 'p1', '<p>x</p>')).not.toBe(computeContentHash('U', 'p1', '<p>x</p>'));
  });

  it('changes when the parent changes, so that a moved file is not skipped', () => {
    expect(computeContentHash('T', 'p1', '<p>x</p>')).not.toBe(computeContentHash('T', 'p2', '<p>x</p>'));
  });

  it('changes when the body changes', () => {
    expect(computeContentHash('T', 'p1', '<p>x</p>')).not.toBe(computeContentHash('T', 'p1', '<p>y</p>'));
  });

  it('does not collide when a field boundary is crossed by an embedded newline', () => {
    // With parentId === null (serialised as ''), these two triples concatenate to the
    // identical '\n'-joined string ("A\n\nB\nC" vs "A\nB\n\nC" both flatten the same way
    // once the empty parentId collapses the separators) but must hash differently.
    expect(computeContentHash('A\n\nB', null, 'C')).not.toBe(computeContentHash('A', null, 'B\n\nC'));
  });
});

describe('PROPERTY_KEYS', () => {
  it('uses the exact content-property key strings, character for character', () => {
    expect(PROPERTY_KEYS.sourcePath).toBe('confluence-docs-publisher.source-path');
    expect(PROPERTY_KEYS.synthetic).toBe('confluence-docs-publisher.synthetic');
    expect(PROPERTY_KEYS.contentHash).toBe('confluence-docs-publisher.content-hash');
    expect(PROPERTY_KEYS.attachmentHashes).toBe('confluence-docs-publisher.attachment-hashes');
  });
});

describe('attachmentHashKey', () => {
  it('uses the base key, unsuffixed, for chunk 0', () => {
    expect(attachmentHashKey(0)).toBe('confluence-docs-publisher.attachment-hashes');
  });

  it('numbers further chunks starting at .2', () => {
    expect(attachmentHashKey(1)).toBe('confluence-docs-publisher.attachment-hashes.2');
    expect(attachmentHashKey(2)).toBe('confluence-docs-publisher.attachment-hashes.3');
  });
});

const planFor = (
  documents: ReturnType<typeof doc>[],
  index: Map<string, IndexEntry>,
  options: Partial<{ unmanaged: IndexEntry[]; exists: (p: string) => boolean }> = {},
) => {
  const roots = buildTree(documents, 'docs');
  const storage = new Map(documents.map((d) => [d.sourcePath, { xhtml: `<p>${d.sourcePath}</p>`, attachments: [] }]));
  return buildPlan({
    roots,
    storageBySourcePath: storage,
    index,
    unmanagedEntries: options.unmanaged ?? [],
    rootParentId: 'root',
    sourceExists: options.exists ?? ((p) => documents.some((d) => d.sourcePath === p)),
  });
};

describe('buildPlan', () => {
  it('plans a create for a source absent from the index', () => {
    const plan = planFor([doc('docs/a.md')], new Map());
    expect(plan.pages[0]!.action).toBe('create');
    expect(plan.pages[0]!.pageId).toBeNull();
    expect(plan.pages[0]!.expectedParentId).toBe('root');
  });

  it('plans a skip when the stored hash matches', () => {
    const a = doc('docs/a.md');
    const hash = computeContentHash(a.title, 'root', '<p>docs/a.md</p>');
    const index = new Map([['docs/a.md', entry({ pageId: '1', sourcePath: 'docs/a.md', title: a.title, contentHash: hash })]]);
    expect(planFor([a], index).pages[0]!.action).toBe('skip');
  });

  it('plans an update when the stored hash differs', () => {
    const a = doc('docs/a.md');
    const index = new Map([['docs/a.md', entry({ pageId: '1', sourcePath: 'docs/a.md', contentHash: 'stale' })]]);
    const planned = planFor([a], index).pages[0]!;
    expect(planned.action).toBe('update');
    expect(planned.pageId).toBe('1');
  });

  it('plans an update when the page carries no hash at all (adoption)', () => {
    const index = new Map([['docs/a.md', entry({ pageId: '1', sourcePath: 'docs/a.md', contentHash: null })]]);
    expect(planFor([doc('docs/a.md')], index).pages[0]!.action).toBe('update');
  });

  it('plans a move when the current parent differs from the expected one', () => {
    const a = doc('docs/sub/a.md');
    const index = new Map([
      ['docs/sub/', entry({ pageId: 'c1', sourcePath: 'docs/sub/', synthetic: true, parentId: 'root' })],
      ['docs/sub/a.md', entry({ pageId: '1', sourcePath: 'docs/sub/a.md', parentId: 'elsewhere' })],
    ]);
    const planned = planFor([a], index).pages.find((p) => p.node.sourcePath === 'docs/sub/a.md')!;
    expect(planned.action).toBe('move');
    expect(planned.expectedParentId).toBe('c1');
  });

  it('plans a move rather than a skip when the parent differs even if the stored hash already matches', () => {
    // The stored content-hash was computed against the *expected* new parent 'c1' (e.g. by a
    // previous planning pass), but the page has not actually been moved on Confluence yet:
    // its real parentId is still 'elsewhere'. A hash-equality check alone would wrongly skip
    // this page and leave it stranded under its old parent; the parent-mismatch check must
    // take priority over the hash comparison.
    const a = doc('docs/sub/a.md');
    const matchingHash = computeContentHash(a.title, 'c1', '<p>docs/sub/a.md</p>');
    const index = new Map([
      ['docs/sub/', entry({ pageId: 'c1', sourcePath: 'docs/sub/', synthetic: true, parentId: 'root' })],
      [
        'docs/sub/a.md',
        entry({ pageId: '1', sourcePath: 'docs/sub/a.md', parentId: 'elsewhere', contentHash: matchingHash }),
      ],
    ]);
    const planned = planFor([a], index).pages.find((p) => p.node.sourcePath === 'docs/sub/a.md')!;
    expect(planned.action).toBe('move');
  });

  it('plans a move when the expected parent does not exist yet', () => {
    const index = new Map([['docs/sub/a.md', entry({ pageId: '1', sourcePath: 'docs/sub/a.md', parentId: 'root' })]]);
    const planned = planFor([doc('docs/sub/a.md')], index).pages.find((p) => p.node.sourcePath === 'docs/sub/a.md')!;
    expect(planned.action).toBe('move');
    expect(planned.expectedParentId).toBeNull();
  });

  it('emits parents before children', () => {
    const plan = planFor([doc('docs/sub/a.md')], new Map());
    expect(plan.pages.map((p) => p.node.sourcePath)).toEqual(['docs/sub/', 'docs/sub/a.md']);
  });

  it('names the parent node explicitly, including when the container is a README', () => {
    const plan = planFor([doc('docs/sub/README.md'), doc('docs/sub/a.md')], new Map());
    const byPath = new Map(plan.pages.map((p) => [p.node.sourcePath, p]));
    expect(byPath.get('docs/sub/README.md')!.parentSourcePath).toBeNull();
    expect(byPath.get('docs/sub/a.md')!.parentSourcePath).toBe('docs/sub/README.md');
  });

  it('classifies a tracked page whose source no longer exists as orphan', () => {
    const index = new Map([['docs/gone.md', entry({ pageId: '9', sourcePath: 'docs/gone.md' })]]);
    const plan = planFor([doc('docs/a.md')], index, { exists: (p) => p === 'docs/a.md' });
    expect(plan.leftovers).toEqual([{ entry: index.get('docs/gone.md')!, category: 'orphan' }]);
  });

  it('classifies a tracked page still present but filtered out by globs as excluded', () => {
    const index = new Map([['docs/kept.md', entry({ pageId: '9', sourcePath: 'docs/kept.md' })]]);
    const plan = planFor([doc('docs/a.md')], index, { exists: () => true });
    expect(plan.leftovers[0]!.category).toBe('excluded');
  });

  it('classifies a page without source-path as unmanaged, never as orphan', () => {
    const stray = entry({ pageId: '7', sourcePath: null, title: 'Manuale' });
    const plan = planFor([doc('docs/a.md')], new Map(), { unmanaged: [stray] });
    expect(plan.leftovers).toEqual([{ entry: stray, category: 'unmanaged' }]);
  });

  it('treats a synthetic container whose folder still exists but is excluded as excluded', () => {
    const index = new Map([['docs/sub/', entry({ pageId: '5', sourcePath: 'docs/sub/', synthetic: true })]]);
    const plan = planFor([doc('docs/a.md')], index, { exists: (p) => p === 'docs/sub/' || p === 'docs/a.md' });
    expect(plan.leftovers[0]!.category).toBe('excluded');
  });

  it('never reports a synthetic container that is part of the current publication', () => {
    const index = new Map([['docs/sub/', entry({ pageId: '5', sourcePath: 'docs/sub/', synthetic: true })]]);
    const plan = planFor([doc('docs/sub/a.md')], index, { exists: () => true });
    expect(plan.leftovers).toEqual([]);
  });
});
