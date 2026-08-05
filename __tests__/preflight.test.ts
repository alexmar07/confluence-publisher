import { describe, expect, it } from 'vitest';
import { ConfluenceClient } from '../src/confluence/client.js';
import { parseMarkdown } from '../src/markdown/parse.js';
import { buildTree, flattenTree, type PageNode } from '../src/tree.js';
import {
  applyAdoptions,
  applyMoves,
  detectMoves,
  formatConflicts,
  preflightEnvironment,
  preflightTitles,
  PreflightError,
  type TitleConflict,
} from '../src/preflight.js';
import { buildPlan, computeContentHash, type IndexEntry } from '../src/plan.js';

type Handler = (url: URL) => Response;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('', { status: 404 });

const clientFor = (routes: Record<string, Handler>) =>
  new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net', username: 'u@a.com', apiToken: 'tok',
    requestTimeoutMs: 1000, maxRetries: 0, sleep: async () => {},
    // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
    fetchImpl: async (input) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- test doubles only ever pass a URL or string here
      const url = new URL(String(input));
      return (routes[url.pathname] ?? notFound)(url);
    },
  });

const space = { '/wiki/api/v2/spaces': () => json({ results: [{ id: '42', key: 'DOC' }] }) };

describe('preflightEnvironment', () => {
  it('resolves the space and accepts a parent page of the same space', async () => {
    const client = clientFor({
      ...space,
      '/wiki/api/v2/pages/1': () => json({ id: '1', title: 'Root', status: 'current', spaceId: '42' }),
    });
    await expect(preflightEnvironment(client, 'DOC', '1')).resolves.toEqual({ spaceId: '42', parentTitle: 'Root' });
  });

  it('reports an unknown space distinctly from a permission problem', async () => {
    const client = clientFor({ '/wiki/api/v2/spaces': () => json({ results: [] }) });
    await expect(preflightEnvironment(client, 'NOPE', '1')).rejects.toBeInstanceOf(PreflightError);
    await expect(preflightEnvironment(client, 'NOPE', '1')).rejects.toThrow(/space "NOPE" does not exist/i);
  });

  it('reports a 403 on the space lookup as a permission problem', async () => {
    const client = clientFor({ '/wiki/api/v2/spaces': () => new Response('forbidden', { status: 403 }) });
    await expect(preflightEnvironment(client, 'DOC', '1')).rejects.toThrow(/permission/i);
  });

  it('states plainly that the parent is a Folder, not a Page', async () => {
    const client = clientFor({ ...space, '/wiki/api/v2/folders/1': () => json({ id: '1', type: 'folder' }) });
    await expect(preflightEnvironment(client, 'DOC', '1')).rejects.toThrow(
      /parent-page-id "1" is a Folder, not a Page/i,
    );
  });

  it('lists the residual causes when the parent is neither page nor folder', async () => {
    const client = clientFor({ ...space });
    const error = (await preflightEnvironment(client, 'DOC', '1').catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/deleted or in the trash/i);
    expect(error.message).toMatch(/different space/i);
  });

  it('blocks when the parent belongs to another space', async () => {
    const client = clientFor({
      ...space,
      '/wiki/api/v2/pages/1': () => json({ id: '1', title: 'Root', status: 'current', spaceId: '99' }),
    });
    await expect(preflightEnvironment(client, 'DOC', '1')).rejects.toThrow(/belongs to space id 99/i);
  });
});

const nodesOf = (paths: string[], bodies: Record<string, string> = {}) =>
  flattenTree(buildTree(paths.map((p) => parseMarkdown(p, bodies[p] ?? `# ${p}\n`, 'h1')), 'docs'));

const entry = (over: Partial<IndexEntry> & Pick<IndexEntry, 'pageId' | 'sourcePath'>): IndexEntry => ({
  title: 'x', parentId: 'root', synthetic: false, contentHash: null, attachmentHashes: {}, ...over,
});

describe('preflightTitles', () => {
  it('passes when every title is unique and unclaimed', async () => {
    const client = clientFor({ '/wiki/api/v2/pages': () => json({ results: [], _links: {} }) });
    await expect(
      preflightTitles(client, '42', nodesOf(['docs/a.md', 'docs/b.md']), new Map(), 2),
    ).resolves.toEqual({ conflicts: [], adoptions: [] });
  });

  it('flags two sources claiming the same title', async () => {
    const client = clientFor({ '/wiki/api/v2/pages': () => json({ results: [], _links: {} }) });
    const nodes = nodesOf(['docs/a.md', 'docs/sub/b.md'], { 'docs/a.md': '# Stesso\n', 'docs/sub/b.md': '# Stesso\n' });
    const { conflicts } = await preflightTitles(client, '42', nodes, new Map(), 2);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ reason: 'internal-duplicate', title: 'Stesso' });
    expect(conflicts[0]!.sources.sort()).toEqual(['docs/a.md', 'docs/sub/b.md']);
  });

  it('includes synthetic container titles in the uniqueness check', async () => {
    const client = clientFor({ '/wiki/api/v2/pages': () => json({ results: [], _links: {} }) });
    const nodes = nodesOf(['docs/sub/x.md', 'docs/a.md'], { 'docs/a.md': '# sub\n' });
    const { conflicts } = await preflightTitles(client, '42', nodes, new Map(), 2);
    expect(conflicts[0]!.sources.sort()).toEqual(['docs/a.md', 'docs/sub/']);
  });

  it('does not flag the page already managed for that very source', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages': () => json({ results: [{ id: '7', title: 'docs/a.md', status: 'current' }], _links: {} }),
      '/wiki/api/v2/pages/7/properties': () =>
        json({ results: [{ id: '1', key: 'confluence-docs-publisher.source-path', value: 'docs/a.md', version: { number: 1 } }], _links: {} }),
    });
    const index = new Map([['docs/a.md', entry({ pageId: '7', sourcePath: 'docs/a.md' })]]);
    await expect(preflightTitles(client, '42', nodesOf(['docs/a.md']), index, 2)).resolves.toEqual({
      conflicts: [],
      adoptions: [],
    });
  });

  it('returns a same-titled page without any source-path as an adoption, not a conflict', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages': () => json({ results: [{ id: '8', title: 'docs/a.md', status: 'current' }], _links: {} }),
      '/wiki/api/v2/pages/8/properties': () => json({ results: [], _links: {} }),
    });
    const { conflicts, adoptions } = await preflightTitles(client, '42', nodesOf(['docs/a.md']), new Map(), 2);
    expect(conflicts).toEqual([]);
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]).toMatchObject({ sourcePath: 'docs/a.md', page: { id: '8' } });
  });

  // The adoption above and this conflict differ on one predicate only (`known === undefined`),
  // and that predicate is the whole defence against overwriting a third party's page: here the
  // source already owns page 7, so the untracked page 8 that happens to hold the same title must
  // never be adopted — adopting it would repoint the source at page 8 and overwrite its body.
  it('refuses to adopt an untracked same-titled page when the source already owns another page', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages': () => json({ results: [{ id: '8', title: 'docs/a.md', status: 'current' }], _links: {} }),
      '/wiki/api/v2/pages/8/properties': () => json({ results: [], _links: {} }),
    });
    const index = new Map([['docs/a.md', entry({ pageId: '7', sourcePath: 'docs/a.md' })]]);
    const { conflicts, adoptions } = await preflightTitles(client, '42', nodesOf(['docs/a.md']), index, 2);
    expect(adoptions).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      reason: 'untracked-occupant',
      title: 'docs/a.md',
      occupantPageId: '8',
      occupantStatus: 'current',
      occupantSourcePath: null,
    });
  });

  it('flags a same-titled page carrying a different source-path', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages': () => json({ results: [{ id: '9', title: 'docs/a.md', status: 'current' }], _links: {} }),
      '/wiki/api/v2/pages/9/properties': () =>
        json({ results: [{ id: '1', key: 'confluence-docs-publisher.source-path', value: 'docs/other.md', version: { number: 1 } }], _links: {} }),
    });
    const { conflicts } = await preflightTitles(client, '42', nodesOf(['docs/a.md']), new Map(), 2);
    expect(conflicts[0]).toMatchObject({ reason: 'foreign-source-path', occupantSourcePath: 'docs/other.md' });
  });

  it('flags an archived or trashed page occupying the title', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages': () => json({ results: [{ id: '10', title: 'docs/a.md', status: 'trashed' }], _links: {} }),
      '/wiki/api/v2/pages/10/properties': () => json({ results: [], _links: {} }),
    });
    const { conflicts } = await preflightTitles(client, '42', nodesOf(['docs/a.md']), new Map(), 2);
    expect(conflicts[0]).toMatchObject({ reason: 'non-current-status', occupantStatus: 'trashed' });
  });

  it('flags an ambiguous match when several pages share the title', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages': () =>
        json({ results: [{ id: '11', title: 'docs/a.md', status: 'current' }, { id: '12', title: 'docs/a.md', status: 'current' }], _links: {} }),
      '/wiki/api/v2/pages/11/properties': () => json({ results: [], _links: {} }),
      '/wiki/api/v2/pages/12/properties': () => json({ results: [], _links: {} }),
    });
    const { conflicts } = await preflightTitles(client, '42', nodesOf(['docs/a.md']), new Map(), 2);
    expect(conflicts[0]!.reason).toBe('ambiguous-match');
  });

  it('queries current, archived and trashed statuses', async () => {
    let status = '';
    const client = clientFor({
      '/wiki/api/v2/pages': (url) => {
        status = url.searchParams.get('status') ?? '';
        return json({ results: [], _links: {} });
      },
    });
    await preflightTitles(client, '42', nodesOf(['docs/a.md']), new Map(), 2);
    expect(status).toBe('current,archived,trashed');
  });
});

describe('applyAdoptions', () => {
  it('moves the adopted page from the unmanaged list into the index', () => {
    const adopted = entry({ pageId: '8', sourcePath: null, title: 'Guide' });
    const bySourcePath = new Map<string, IndexEntry>();
    const unmanaged = [adopted, entry({ pageId: '9', sourcePath: null, title: 'Altro' })];

    const remaining = applyAdoptions(
      [{ sourcePath: 'docs/a.md', page: { id: '8', title: 'Guide', status: 'current', parentId: 'root', spaceId: '42' } }],
      bySourcePath,
      unmanaged,
    );

    expect(bySourcePath.get('docs/a.md')).toMatchObject({ pageId: '8', sourcePath: 'docs/a.md', contentHash: null });
    expect(remaining.map((e) => e.pageId)).toEqual(['9']);
  });

  it('adopts a page that lies outside the descendant scan as well', () => {
    const bySourcePath = new Map<string, IndexEntry>();
    const remaining = applyAdoptions(
      [{ sourcePath: 'docs/a.md', page: { id: '30', title: 'Guide', status: 'current', parentId: 'other', spaceId: '42' } }],
      bySourcePath,
      [],
    );
    expect(bySourcePath.get('docs/a.md')).toMatchObject({ pageId: '30', parentId: 'other' });
    expect(remaining).toEqual([]);
  });
});

const storageOf = (over: Record<string, string>) =>
  new Map(Object.entries(over).map(([sourcePath, xhtml]) => [sourcePath, { xhtml, attachments: [] }]));

describe('detectMoves + applyMoves', () => {
  it('pairs a vanished entry with a fresh cross-folder node and grafts a move, clearing it from R7 orphans', () => {
    const docs = [parseMarkdown('docs/new/a.md', '# T\n', 'h1')];
    const roots = buildTree(docs, 'docs');
    const nodes = flattenTree(roots);
    const bodyXhtml = '<p>body</p>';
    const storage = storageOf({ 'docs/new/a.md': bodyXhtml });

    // The stored hash was computed the day the page still lived under 'oldparent': recomputing
    // it against that same old parent, but with the *fresh* node's body, is what condition 2
    // must reproduce for the pairing to hold.
    const vanishedHash = computeContentHash('T', 'oldparent', bodyXhtml);
    const index = new Map<string, IndexEntry>([
      ['docs/old/a.md', entry({ pageId: '1', sourcePath: 'docs/old/a.md', title: 'T', parentId: 'oldparent', contentHash: vanishedHash })],
      ['docs/new/', entry({ pageId: 'c2', sourcePath: 'docs/new/', synthetic: true, title: 'new', parentId: 'root' })],
    ]);
    const sourceExists = (p: string) => p !== 'docs/old/a.md';

    const moves = detectMoves(nodes, index, storage, sourceExists);
    expect(moves).toEqual([{ vanished: index.get('docs/old/a.md'), freshSourcePath: 'docs/new/a.md' }]);

    applyMoves(moves, index);
    expect(index.has('docs/old/a.md')).toBe(false);
    expect(index.get('docs/new/a.md')).toMatchObject({ pageId: '1', parentId: 'oldparent', contentHash: null });

    const plan = buildPlan({
      roots, storageBySourcePath: storage, index, unmanagedEntries: [], rootParentId: 'root', sourceExists,
    });
    const leaf = plan.pages.find((p) => p.node.sourcePath === 'docs/new/a.md');
    expect(leaf!.action).toBe('move');
    // The vanished entry was consumed by the move, so it must not surface as an orphan.
    expect(plan.leftovers).toEqual([]);
  });

  it('plans a same-folder rename as an update, so the source-path property gets rewritten', () => {
    const docs = [parseMarkdown('docs/b.md', '# T\n', 'h1')];
    const roots = buildTree(docs, 'docs');
    const nodes = flattenTree(roots);
    const bodyXhtml = '<p>body</p>';
    const storage = storageOf({ 'docs/b.md': bodyXhtml });

    const vanishedHash = computeContentHash('T', 'root', bodyXhtml);
    const index = new Map<string, IndexEntry>([
      ['docs/a.md', entry({ pageId: '1', sourcePath: 'docs/a.md', title: 'T', parentId: 'root', contentHash: vanishedHash })],
    ]);
    const sourceExists = (p: string) => p !== 'docs/a.md';

    const moves = detectMoves(nodes, index, storage, sourceExists);
    applyMoves(moves, index);

    const plan = buildPlan({
      roots, storageBySourcePath: storage, index, unmanagedEntries: [], rootParentId: 'root', sourceExists,
    });
    const leaf = plan.pages.find((p) => p.node.sourcePath === 'docs/b.md')!;
    // Same parent, so a hash carried forward would have produced 'skip' and the property write
    // in execute() would never run; the graft's null hash is what forces 'update' instead.
    expect(leaf.action).toBe('update');
    expect(leaf.pageId).toBe('1');
  });

  // The one field where applyMoves deliberately diverges from applyAdoptions: a detected move is
  // proof that this is the same page, so its recorded upload state stays valid. Resetting it would
  // re-upload every attachment through the legacy endpoint on the very next run, minting a new
  // attachment version per file for zero content change. Adoption, whose upload history this
  // action never produced, must keep resetting it.
  it('carries attachmentHashes forward on a move, while adoption still resets them', () => {
    const vanished = entry({
      pageId: '1',
      sourcePath: 'docs/old/a.md',
      title: 'T',
      parentId: 'oldparent',
      contentHash: 'h',
      attachmentHashes: { 'a.png': 'hash-a', 'b.png': 'hash-b' },
    });
    const index = new Map<string, IndexEntry>([['docs/old/a.md', vanished]]);

    applyMoves([{ vanished, freshSourcePath: 'docs/new/a.md' }], index);

    expect(index.get('docs/new/a.md')!.attachmentHashes).toEqual({ 'a.png': 'hash-a', 'b.png': 'hash-b' });

    const adoptedInto = new Map<string, IndexEntry>();
    applyAdoptions(
      [{ sourcePath: 'docs/b.md', page: { id: '8', title: 'T', status: 'current', parentId: 'root', spaceId: '42' } }],
      adoptedInto,
      [],
    );
    expect(adoptedInto.get('docs/b.md')!.attachmentHashes).toEqual({});
  });

  it('does not match a vanished entry against a fresh node whose content also changed', () => {
    const docs = [parseMarkdown('docs/new/a.md', '# T\n', 'h1')];
    const nodes = flattenTree(buildTree(docs, 'docs'));
    const storage = storageOf({ 'docs/new/a.md': '<p>changed</p>' });

    const vanishedHash = computeContentHash('T', 'oldparent', '<p>original</p>');
    const index = new Map<string, IndexEntry>([
      ['docs/old/a.md', entry({ pageId: '1', sourcePath: 'docs/old/a.md', title: 'T', parentId: 'oldparent', contentHash: vanishedHash })],
    ]);

    const moves = detectMoves(nodes, index, storage, (p) => p !== 'docs/old/a.md');
    expect(moves).toEqual([]);
  });

  it('does not match a vanished entry with no stored content-hash', () => {
    const docs = [parseMarkdown('docs/new/a.md', '# T\n', 'h1')];
    const nodes = flattenTree(buildTree(docs, 'docs'));
    const bodyXhtml = '<p>body</p>';
    const storage = storageOf({ 'docs/new/a.md': bodyXhtml });

    // entry()'s default contentHash is null: nothing to prove condition 2 against, whatever
    // computeContentHash(y.title, x.parentId, y_xhtml) would evaluate to.
    const index = new Map<string, IndexEntry>([
      ['docs/old/a.md', entry({ pageId: '1', sourcePath: 'docs/old/a.md', title: 'T', parentId: 'oldparent' })],
    ]);

    const moves = detectMoves(nodes, index, storage, (p) => p !== 'docs/old/a.md');
    expect(moves).toEqual([]);
  });

  // This exact configuration is unreachable in a real run: two fresh nodes sharing a title
  // still make it through detectMoves (which runs first), but the very same run then aborts at
  // preflightTitles's own internal-duplicate check before any write, so it never matters in
  // practice whether detectMoves matched one of them or none. The guard is kept regardless, as
  // defence in depth — do not simplify it away on the grounds that "this can't happen".
  it('yields no move when a vanished entry matches more than one fresh node (one-to-many)', () => {
    const docs = [
      parseMarkdown('docs/one/a.md', '# T\n', 'h1'),
      parseMarkdown('docs/two/a.md', '# T\n', 'h1'),
    ];
    const nodes = flattenTree(buildTree(docs, 'docs'));
    const bodyXhtml = '<p>body</p>';
    const storage = storageOf({ 'docs/one/a.md': bodyXhtml, 'docs/two/a.md': bodyXhtml });

    const vanishedHash = computeContentHash('T', 'oldparent', bodyXhtml);
    const index = new Map<string, IndexEntry>([
      ['docs/old/a.md', entry({ pageId: '1', sourcePath: 'docs/old/a.md', title: 'T', parentId: 'oldparent', contentHash: vanishedHash })],
    ]);

    const moves = detectMoves(nodes, index, storage, (p) => p !== 'docs/old/a.md');
    expect(moves).toEqual([]);
  });

  // Also unreachable in a real run: Confluence itself enforces title uniqueness within a
  // space, so two *current* pages cannot both hold the title 'T' there — the index this
  // fixture fabricates could never be read back from a real site. The guard is kept regardless,
  // as defence in depth against a future change to how the index is built.
  it('yields no move when a fresh node matches more than one vanished entry (many-to-one)', () => {
    const docs = [parseMarkdown('docs/new/a.md', '# T\n', 'h1')];
    const nodes = flattenTree(buildTree(docs, 'docs'));
    const bodyXhtml = '<p>body</p>';
    const storage = storageOf({ 'docs/new/a.md': bodyXhtml });

    const hashUnderOld1 = computeContentHash('T', 'old1', bodyXhtml);
    const hashUnderOld2 = computeContentHash('T', 'old2', bodyXhtml);
    const index = new Map<string, IndexEntry>([
      ['docs/old1/a.md', entry({ pageId: '1', sourcePath: 'docs/old1/a.md', title: 'T', parentId: 'old1', contentHash: hashUnderOld1 })],
      ['docs/old2/a.md', entry({ pageId: '2', sourcePath: 'docs/old2/a.md', title: 'T', parentId: 'old2', contentHash: hashUnderOld2 })],
    ]);
    const sourceExists = (p: string) => p !== 'docs/old1/a.md' && p !== 'docs/old2/a.md';

    const moves = detectMoves(nodes, index, storage, sourceExists);
    expect(moves).toEqual([]);
  });

  // Synthetic containers render as xhtml: '' (see src/index.ts), and execute() does write them
  // a content-hash, so a vanished container titled 'T' under old parent 'oldparent' stores
  // exactly computeContentHash('T', 'oldparent', ''). A fresh, non-synthetic, front-matter-only
  // file titled 'T' also renders to ''. Without the synthetic-vanished filter, condition 2
  // would hold and the container's page would be silently grafted onto that unrelated leaf —
  // a wrong-page overwrite. Every other field lines up (title, hash) so this only fails if the
  // `!entry.synthetic` filter on the vanished side is actually applied.
  it('excludes a synthetic vanished entry even though title and the "moved" hash both match a fresh node', () => {
    const bodyXhtml = ''; // what a synthetic container, and a front-matter-only file, both render to
    const vanishedHash = computeContentHash('T', 'oldparent', bodyXhtml);
    const index = new Map<string, IndexEntry>([
      ['docs/old/', entry({ pageId: '9', sourcePath: 'docs/old/', synthetic: true, title: 'T', parentId: 'oldparent', contentHash: vanishedHash })],
    ]);
    const freshLeaf: PageNode = { sourcePath: 'docs/new/a.md', synthetic: false, title: 'T', document: null, children: [] };
    const storage = storageOf({ 'docs/new/a.md': bodyXhtml });

    const moves = detectMoves([freshLeaf], index, storage, (p) => p !== 'docs/old/');
    expect(moves).toEqual([]);
  });

  // Mirror image: a non-synthetic vanished entry that would otherwise match a *synthetic*
  // fresh container (a brand-new, empty-bodied folder page) on both title and the relocated
  // hash. Every field lines up except that the candidate sits on the synthetic side, so this
  // only fails if the `!node.synthetic` filter on the fresh side is actually applied.
  it('excludes a synthetic fresh node even though title and the "moved" hash both match a vanished entry', () => {
    const bodyXhtml = '';
    const vanishedHash = computeContentHash('T', 'oldparent', bodyXhtml);
    const index = new Map<string, IndexEntry>([
      ['docs/old/a.md', entry({ pageId: '1', sourcePath: 'docs/old/a.md', title: 'T', parentId: 'oldparent', contentHash: vanishedHash })],
    ]);
    const freshContainer: PageNode = { sourcePath: 'docs/new/', synthetic: true, title: 'T', document: null, children: [] };
    const storage = storageOf({ 'docs/new/': bodyXhtml });

    const moves = detectMoves([freshContainer], index, storage, (p) => p !== 'docs/old/a.md');
    expect(moves).toEqual([]);
  });
});

describe('formatConflicts', () => {
  const base: TitleConflict = {
    title: 'Guide',
    sources: ['docs/a.md'],
    occupantPageId: null,
    occupantStatus: null,
    occupantSourcePath: null,
    reason: 'internal-duplicate',
  };

  it('formats an internal-duplicate conflict, listing every claiming source', () => {
    const conflict: TitleConflict = { ...base, sources: ['docs/a.md', 'docs/sub/b.md'] };
    const message = formatConflicts([conflict]);
    expect(message).toContain('Title preflight failed with 1 conflict(s):');
    expect(message).toContain(
      '- "Guide" is claimed by docs/a.md, docs/sub/b.md. Add an explicit H1 or a front matter "title" field to one of them.',
    );
  });

  it('formats a foreign-source-path conflict, naming the occupant page and its source', () => {
    const conflict: TitleConflict = {
      ...base,
      reason: 'foreign-source-path',
      occupantPageId: '9',
      occupantSourcePath: 'docs/other.md',
    };
    // No sourceExists predicate passed: defaults to "everything exists", so the wording stays
    // exactly as it was before move detection existed.
    const message = formatConflicts([conflict]);
    expect(message).toContain(
      '- "Guide" (requested by docs/a.md) is already used by page 9, which belongs to docs/other.md.',
    );
  });

  it('names the vanished-source cause and remedy when the occupant\'s own source no longer exists (a move edited in the same commit)', () => {
    const conflict: TitleConflict = {
      ...base,
      reason: 'foreign-source-path',
      occupantPageId: '9',
      occupantSourcePath: 'docs/other.md',
    };
    const message = formatConflicts([conflict], (sourcePath) => sourcePath !== 'docs/other.md');
    expect(message).toContain(
      '- "Guide" (requested by docs/a.md) is already used by page 9, which belongs to docs/other.md, '
        + 'whose source file no longer exists. If you moved this file and edited it in the same commit, '
        + 'publish the move first, then the edit.',
    );
  });

  it('formats a non-current-status conflict, naming the occupant page and its status', () => {
    const conflict: TitleConflict = {
      ...base,
      reason: 'non-current-status',
      occupantPageId: '10',
      occupantStatus: 'trashed',
    };
    const message = formatConflicts([conflict]);
    expect(message).toContain(
      '- "Guide" (requested by docs/a.md) is occupied by page 10 in status "trashed". Purge it from the trash or choose a different title.',
    );
  });

  it('formats an ambiguous-match conflict without naming any single occupant', () => {
    const conflict: TitleConflict = { ...base, reason: 'ambiguous-match' };
    const message = formatConflicts([conflict]);
    expect(message).toContain(
      '- "Guide" (requested by docs/a.md) matches more than one page in the space: adoption would be ambiguous.',
    );
  });

  it('formats an untracked-occupant conflict, naming the occupant page', () => {
    const conflict: TitleConflict = {
      ...base,
      reason: 'untracked-occupant',
      occupantPageId: '11',
    };
    const message = formatConflicts([conflict]);
    expect(message).toContain(
      '- "Guide" (requested by docs/a.md) is held by untracked page 11, while that source already has a page of its own. Rename one of the two, or delete the untracked page.',
    );
  });

  it('joins multiple conflicts with newlines and reports the total count', () => {
    const message = formatConflicts([base, { ...base, title: 'Altro' }]);
    expect(message.startsWith('Title preflight failed with 2 conflict(s):\n')).toBe(true);
    expect(message.split('\n')).toHaveLength(3);
  });
});

describe('PreflightError', () => {
  // An Error subclass with an empty body inherits name === 'Error', so anything formatting
  // the error by name loses which failure surface it came from.
  it('reports its own class name', () => {
    expect(new PreflightError('x').name).toBe('PreflightError');
  });

  it('keeps the message it was constructed with', () => {
    expect(new PreflightError('x').message).toBe('x');
  });

  it('is still an Error', () => {
    expect(new PreflightError('x') instanceof Error).toBe(true);
  });
});
