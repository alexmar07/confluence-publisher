import { describe, expect, it, vi } from 'vitest';
import { parseMarkdown } from '../src/markdown/parse.js';
import { buildTree } from '../src/tree.js';
import { attachmentHashKey, buildPlan, computeContentHash, PROPERTY_KEYS, type IndexEntry } from '../src/plan.js';
import { executePlan, type ExecuteDeps } from '../src/execute.js';

const doc = (path: string) => parseMarkdown(path, `# ${path}\n`, 'h1');

const planFor = (paths: string[], index = new Map<string, IndexEntry>()) => {
  const documents = paths.map(doc);
  return buildPlan({
    roots: buildTree(documents, 'docs'),
    storageBySourcePath: new Map(documents.map((d) => [d.sourcePath, { xhtml: `<p>${d.sourcePath}</p>`, attachments: [] }])),
    index,
    unmanagedEntries: [],
    rootParentId: 'root',
    sourceExists: () => true,
  });
};

const deps = (over: Partial<ExecuteDeps> = {}): ExecuteDeps => ({
  createPage: vi.fn<ExecuteDeps['createPage']>((_c, input) => Promise.resolve({ id: `new-${input.title}`, title: input.title, status: 'current', parentId: input.parentId, spaceId: '42' })),
  updatePage: vi.fn<ExecuteDeps['updatePage']>((_c, input) => Promise.resolve({ id: input.pageId, title: input.title, status: 'current', parentId: input.parentId, spaceId: '42' })),
  writeProperty: vi.fn<ExecuteDeps['writeProperty']>(() => Promise.resolve()),
  uploadAttachment: vi.fn<ExecuteDeps['uploadAttachment']>(() => Promise.resolve()),
  readFile: vi.fn<ExecuteDeps['readFile']>(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
  log: { info: vi.fn(), warning: vi.fn(), debug: vi.fn() },
  ...over,
});

const client = {} as never;

describe('executePlan', () => {
  it('creates pages parent-first and passes the real parent id to the children', async () => {
    const d = deps();
    const result = await executePlan(client, {
      plan: planFor(['docs/sub/a.md']), spaceId: '42', versionMessage: 'm', concurrency: 2, footer: null, index: new Map(),
    }, d);
    expect(result.outcomes.map((o) => `${o.sourcePath}:${o.kind}`)).toEqual([
      'docs/sub/:created', 'docs/sub/a.md:created',
    ]);
    expect(d.createPage).toHaveBeenNthCalledWith(2, client, expect.objectContaining({ parentId: 'new-sub' }));
  });

  it('attaches leaves to a README-derived container, not to the publication root', async () => {
    const d = deps();
    await executePlan(client, {
      plan: planFor(['docs/sub/README.md', 'docs/sub/a.md']), spaceId: '42', versionMessage: 'm',
      concurrency: 2, footer: null, index: new Map(),
    }, d);
    const calls = vi.mocked(d.createPage).mock.calls;
    const leafCall = calls.find((c) => c[1].title === 'docs/sub/a.md')!;
    expect(leafCall[1].parentId).toBe('new-docs/sub/README.md');
  });

  it('writes source-path, content-hash and the synthetic flag on a container', async () => {
    const d = deps();
    await executePlan(client, { plan: planFor(['docs/sub/a.md']), spaceId: '42', versionMessage: 'm', concurrency: 2, footer: null, index: new Map() }, d);
    const keys = vi.mocked(d.writeProperty).mock.calls.map((c) => c[2]);
    expect(keys).toContain(PROPERTY_KEYS.sourcePath);
    expect(keys).toContain(PROPERTY_KEYS.contentHash);
    expect(keys).toContain(PROPERTY_KEYS.synthetic);
  });

  // The test above only asserts the synthetic key is written *somewhere* in the plan, so the
  // guard that keeps it off real pages was unpinned. Stamping every page synthetic would make
  // buildIndex read them all back as containers, which excludes them from both sides of
  // detectMoves — move detection would stop working permanently and silently.
  it('stamps the synthetic flag on the container only, never on a real leaf', async () => {
    const d = deps();
    await executePlan(client, {
      plan: planFor(['docs/sub/a.md']), spaceId: '42', versionMessage: 'm', concurrency: 2,
      footer: null, index: new Map(),
    }, d);
    const calls = vi.mocked(d.writeProperty).mock.calls;
    const stamped = calls.filter((c) => c[2] === PROPERTY_KEYS.synthetic);
    expect(stamped.map((c) => c[1])).toEqual(['new-sub']);
    expect(stamped.map((c) => c[3])).toEqual([true]);
    // The leaf was published in the same run, so its absence above is a real exclusion.
    expect(calls.some((c) => c[1] === 'new-docs/sub/a.md')).toBe(true);
  });

  it('marks the whole subtree failed when a container fails, without calling the API for it', async () => {
    const d = deps({
      createPage: vi.fn<ExecuteDeps['createPage']>((_c, input) => {
        if (input.title === 'sub') return Promise.reject(Object.assign(new Error('nope'), { status: 500 }));
        return Promise.resolve({ id: 'x', title: input.title, status: 'current', parentId: input.parentId, spaceId: '42' });
      }),
    });
    const result = await executePlan(client, {
      plan: planFor(['docs/sub/a.md', 'docs/other.md']), spaceId: '42', versionMessage: 'm', concurrency: 2, footer: null, index: new Map(),
    }, d);
    const byPath = new Map(result.outcomes.map((o) => [o.sourcePath, o]));
    expect(byPath.get('docs/sub/')!.kind).toBe('failed');
    expect(byPath.get('docs/sub/a.md')!.kind).toBe('failed');
    // The failure message is English, not Italian, since it is the only operator-facing string
    // in an action whose every other message is English.
    expect(byPath.get('docs/sub/a.md')!.error!.message).toMatch(/parent unavailable/);
    expect(byPath.get('docs/other.md')!.kind).toBe('created');
    expect(vi.mocked(d.createPage).mock.calls.map((c) => c[1].title)).not.toContain('docs/sub/a.md');
  });

  it('keeps publishing the remaining leaves after a leaf failure', async () => {
    const d = deps({
      createPage: vi.fn<ExecuteDeps['createPage']>((_c, input) => {
        if (input.title === 'docs/b.md') return Promise.reject(Object.assign(new Error('bad xhtml'), { status: 400 }));
        return Promise.resolve({ id: 'x', title: input.title, status: 'current', parentId: input.parentId, spaceId: '42' });
      }),
    });
    const result = await executePlan(client, {
      plan: planFor(['docs/a.md', 'docs/b.md', 'docs/c.md']), spaceId: '42', versionMessage: 'm', concurrency: 3, footer: null, index: new Map(),
    }, d);
    expect(result.outcomes.filter((o) => o.kind === 'created')).toHaveLength(2);
    expect(result.outcomes.filter((o) => o.kind === 'failed')).toHaveLength(1);
  });

  it('does not call updatePage for a skipped page', async () => {
    const d = deps();
    const documents = [doc('docs/a.md')];
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    const result = await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index: new Map() }, d);
    expect(result.outcomes[0]!.kind).toBe('skipped');
    expect(d.updatePage).not.toHaveBeenCalled();
    void documents;
  });

  it('appends the footer to the written body while hashing the body without it', async () => {
    const d = deps();
    const plan = planFor(['docs/a.md']);
    const hashBefore = plan.pages[0]!.contentHash;
    await executePlan(client, {
      plan, spaceId: '42', versionMessage: 'm', concurrency: 1,
      footer: (p) => `<hr/><p>${p}</p>`, index: new Map(),
    }, d);
    const written = vi.mocked(d.createPage).mock.calls[0]![1].storage;
    expect(written).toContain('<hr/><p>docs/a.md</p>');
    const hashCall = vi.mocked(d.writeProperty).mock.calls.find((c) => c[2] === PROPERTY_KEYS.contentHash);
    expect(hashCall![3]).toBe(hashBefore);
  });

  it('re-uploads a changed attachment on a skipped page and keeps the outcome skipped', async () => {
    const d = deps();
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/x.png', filename: 'x.png' }];
    const index = new Map<string, IndexEntry>([
      ['docs/a.md', { pageId: '7', title: 'a', parentId: 'root', sourcePath: 'docs/a.md', synthetic: false, contentHash: plan.pages[0]!.contentHash, attachmentHashes: { 'x.png': 'stale' } }],
    ]);
    const result = await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index }, d);
    expect(d.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(result.attachmentsUploaded).toBe(1);
    expect(result.outcomes[0]!.kind).toBe('skipped');
  });

  it('does not re-upload an attachment whose hash is unchanged', async () => {
    const { attachmentHash } = await import('../src/confluence/legacyAttachments.js');
    const d = deps();
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/x.png', filename: 'x.png' }];
    const index = new Map<string, IndexEntry>([
      ['docs/a.md', { pageId: '7', title: 'a', parentId: 'root', sourcePath: 'docs/a.md', synthetic: false, contentHash: plan.pages[0]!.contentHash, attachmentHashes: { 'x.png': attachmentHash(new Uint8Array([1, 2, 3])) } }],
    ]);
    await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index }, d);
    expect(d.uploadAttachment).not.toHaveBeenCalled();
  });

  // The shrink case is the one the stale-chunk cleanup was written for, and the one that could
  // not reach it: a removed attachment never enters `pending` (only local filenames do), so a run
  // whose only change is a removal must still rewrite the hash property and empty stale chunks.
  it('rewrites the attachment-hash property and empties stale chunks when the attachment set shrank', async () => {
    const { attachmentHash } = await import('../src/confluence/legacyAttachments.js');
    const hash = attachmentHash(new Uint8Array([1, 2, 3]));
    const d = deps();
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/x.png', filename: 'x.png' }];
    const index = new Map<string, IndexEntry>([
      ['docs/a.md', {
        pageId: '7', title: 'a', parentId: 'root', sourcePath: 'docs/a.md', synthetic: false,
        contentHash: plan.pages[0]!.contentHash,
        attachmentHashes: { 'x.png': hash, 'gone.png': 'stale' },
      }],
    ]);
    const staleChunkKey = attachmentHashKey(1);
    const knownForSeven = new Map([
      [PROPERTY_KEYS.attachmentHashes, { propertyId: '1', version: 1, value: { 'x.png': hash } }],
      [staleChunkKey, { propertyId: '2', version: 1, value: { 'gone.png': 'stale' } }],
    ]);

    await executePlan(client, {
      plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index,
      knownProperties: new Map([['7', knownForSeven]]),
    }, d);

    expect(d.uploadAttachment).not.toHaveBeenCalled();
    const written = new Map(vi.mocked(d.writeProperty).mock.calls.map((c) => [c[2], c[3]]));
    expect(written.get(PROPERTY_KEYS.attachmentHashes)).toEqual({ 'x.png': hash });
    expect(written.get(staleChunkKey)).toEqual({});
  });

  // chunkAttachmentHashes seeds its result with `[{}]`, so an empty hash map still yields
  // exactly one chunk: `{}`. When every attachment on a page is unreadable and no
  // attachment-hashes property exists yet, `merged` is empty and the un-guarded loop wrote that
  // `{}` anyway — a needless property POST creating an empty record on a page that never had
  // one. The fix is narrow: skip only a chunk that is both empty and has no existing record
  // under its key in `known`.
  it('does not write an attachment-hashes property when every attachment is unreadable and none was ever stored', async () => {
    const d = deps({ readFile: vi.fn<ExecuteDeps['readFile']>(() => Promise.reject(new Error('EACCES'))) });
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/x.png', filename: 'x.png' }];
    await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index: new Map() }, d);
    expect(d.writeProperty).not.toHaveBeenCalled();
  });

  it('still writes an empty attachment-hashes property when every attachment is unreadable but a property already exists (clear-on-shrink)', async () => {
    const d = deps({ readFile: vi.fn<ExecuteDeps['readFile']>(() => Promise.reject(new Error('EACCES'))) });
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/x.png', filename: 'x.png' }];
    const knownForSeven = new Map([
      [PROPERTY_KEYS.attachmentHashes, { propertyId: '1', version: 1, value: { 'x.png': 'stale-hash' } }],
    ]);
    await executePlan(client, {
      plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index: new Map(),
      knownProperties: new Map([['7', knownForSeven]]),
    }, d);
    expect(d.writeProperty).toHaveBeenCalledWith(client, '7', PROPERTY_KEYS.attachmentHashes, {}, knownForSeven);
  });

  // The mixed set is the case `merged`'s seeding exists for. Seeding it from `stored` when
  // anything was unreadable is what preserves the unreadable file's recorded hash; the readable
  // ones must still overwrite theirs. Kills the mutant that always starts `merged` empty.
  it('keeps the stored hash of an unreadable attachment while refreshing the readable ones', async () => {
    const { attachmentHash } = await import('../src/confluence/legacyAttachments.js');
    const bytesOf: Record<string, Uint8Array> = {
      'docs/img/a.png': new Uint8Array([1, 1, 1]),
      'docs/img/b.png': new Uint8Array([2, 2, 2]),
    };
    const d = deps({
      readFile: vi.fn<ExecuteDeps['readFile']>((sourcePath) => {
        const data = bytesOf[sourcePath];
        return data === undefined ? Promise.reject(new Error('EACCES')) : Promise.resolve(data);
      }),
    });
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [
      { sourcePath: 'docs/img/a.png', filename: 'a.png' },
      { sourcePath: 'docs/img/b.png', filename: 'b.png' },
      { sourcePath: 'docs/img/locked.png', filename: 'locked.png' },
    ];
    const index = new Map<string, IndexEntry>([
      ['docs/a.md', {
        pageId: '7', title: 'a', parentId: 'root', sourcePath: 'docs/a.md', synthetic: false,
        contentHash: plan.pages[0]!.contentHash,
        attachmentHashes: { 'a.png': 'stale-a', 'b.png': 'stale-b', 'locked.png': 'recorded-locked' },
      }],
    ]);

    await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index }, d);

    const written = new Map(vi.mocked(d.writeProperty).mock.calls.map((c) => [c[2], c[3]]));
    expect(written.get(PROPERTY_KEYS.attachmentHashes)).toEqual({
      'a.png': attachmentHash(bytesOf['docs/img/a.png'] as Uint8Array),
      'b.png': attachmentHash(bytesOf['docs/img/b.png'] as Uint8Array),
      'locked.png': 'recorded-locked',
    });
    expect(vi.mocked(d.uploadAttachment).mock.calls.map((c) => c[2]).sort()).toEqual(['a.png', 'b.png']);
    expect(d.log.warning).toHaveBeenCalledWith(expect.stringContaining('locked.png'));
  });

  // The mirror case — every file readable, so `merged` must start empty and carry only the
  // local hashes. Kills the mutant that always seeds it from `stored` (which would resurrect
  // gone.png) and pins that a local file absent from `stored` gets its fresh hash written.
  it('writes fresh hashes for every readable attachment, dropping stored entries with no local file', async () => {
    const { attachmentHash } = await import('../src/confluence/legacyAttachments.js');
    const bytesOf: Record<string, Uint8Array> = {
      'docs/img/a.png': new Uint8Array([1, 1, 1]),
      'docs/img/b.png': new Uint8Array([2, 2, 2]),
    };
    const d = deps({
      readFile: vi.fn<ExecuteDeps['readFile']>((sourcePath) => Promise.resolve(bytesOf[sourcePath] as Uint8Array)),
    });
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [
      { sourcePath: 'docs/img/a.png', filename: 'a.png' },
      { sourcePath: 'docs/img/b.png', filename: 'b.png' },
    ];
    const hashA = attachmentHash(bytesOf['docs/img/a.png'] as Uint8Array);
    const index = new Map<string, IndexEntry>([
      ['docs/a.md', {
        pageId: '7', title: 'a', parentId: 'root', sourcePath: 'docs/a.md', synthetic: false,
        contentHash: plan.pages[0]!.contentHash,
        // b.png has never been stored; gone.png no longer exists locally.
        attachmentHashes: { 'a.png': hashA, 'gone.png': 'stale' },
      }],
    ]);

    await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index }, d);

    const written = new Map(vi.mocked(d.writeProperty).mock.calls.map((c) => [c[2], c[3]]));
    expect(written.get(PROPERTY_KEYS.attachmentHashes)).toEqual({
      'a.png': hashA,
      'b.png': attachmentHash(bytesOf['docs/img/b.png'] as Uint8Array),
    });
    // Only the never-stored file needed uploading; a.png's hash was already current.
    expect(vi.mocked(d.uploadAttachment).mock.calls.map((c) => c[2])).toEqual(['b.png']);
  });

  // Several surplus numbered chunks at once. They must all be emptied, and the chunk still
  // in use must never be written `{}` — kills both the deletion of the stale-chunk loop and the
  // inversion of its `!stillUsed` test.
  it('empties every surplus numbered chunk while leaving the chunk still in use untouched', async () => {
    const { attachmentHash } = await import('../src/confluence/legacyAttachments.js');
    const hash = attachmentHash(new Uint8Array([1, 2, 3]));
    const d = deps();
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'skip';
    plan.pages[0]!.pageId = '7';
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/x.png', filename: 'x.png' }];
    const index = new Map<string, IndexEntry>([
      ['docs/a.md', {
        pageId: '7', title: 'a', parentId: 'root', sourcePath: 'docs/a.md', synthetic: false,
        contentHash: plan.pages[0]!.contentHash,
        attachmentHashes: { 'x.png': hash },
      }],
    ]);
    const knownForSeven = new Map([
      [attachmentHashKey(0), { propertyId: '1', version: 1, value: { 'x.png': hash } }],
      [attachmentHashKey(1), { propertyId: '2', version: 1, value: { 'old-1.png': 'stale' } }],
      [attachmentHashKey(2), { propertyId: '3', version: 1, value: { 'old-2.png': 'stale' } }],
    ]);

    await executePlan(client, {
      plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index,
      knownProperties: new Map([['7', knownForSeven]]),
    }, d);

    const calls = vi.mocked(d.writeProperty).mock.calls;
    const emptied = calls.filter((c) => JSON.stringify(c[3]) === '{}').map((c) => c[2]).sort();
    expect(emptied).toEqual([attachmentHashKey(1), attachmentHashKey(2)].sort());
    expect(calls.filter((c) => c[2] === attachmentHashKey(0)).map((c) => c[3])).toEqual([{ 'x.png': hash }]);
  });

  it('reports a missing image file as a warning, not as a page failure', async () => {
    const d = deps({ readFile: vi.fn<ExecuteDeps['readFile']>(() => Promise.reject(new Error('ENOENT'))) });
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/gone.png', filename: 'gone.png' }];
    const result = await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index: new Map() }, d);
    expect(result.outcomes[0]!.kind).toBe('created');
    expect(d.log.warning).toHaveBeenCalledWith(expect.stringContaining('gone.png'));
  });

  // errorInfo used to read `(error as {status?: unknown}).status` unconditionally, which
  // throws `TypeError: Cannot read properties of null/undefined` when the rejection reason
  // itself is null or undefined — turning a reportable per-attachment warning into an unhandled
  // exception that would abort the whole run. A readFile rejection with a nullish reason must
  // still be reported as a warning, not thrown.
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('reports a readFile rejection with a %s reason as a warning, not a thrown run', async (_label, reason) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a nullish reason; that is exactly the case this test guards against
    const d = deps({ readFile: vi.fn<ExecuteDeps['readFile']>(() => Promise.reject(reason)) });
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.attachments = [{ sourcePath: 'docs/img/gone.png', filename: 'gone.png' }];
    const result = await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index: new Map() }, d);
    expect(result.outcomes[0]!.kind).toBe('created');
    expect(d.log.warning).toHaveBeenCalledWith(expect.stringContaining('gone.png'));
  });

  it('hands the already-read properties to writeProperty, so no lookup precedes a write', async () => {
    const d = deps();
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'update';
    plan.pages[0]!.pageId = '7';
    const knownForSeven = new Map([
      ['confluence-docs-publisher.content-hash', { propertyId: '11', version: 4, value: 'stale' }],
    ]);
    await executePlan(client, {
      plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null,
      index: new Map(), knownProperties: new Map([['7', knownForSeven]]),
    }, d);
    const calls = vi.mocked(d.writeProperty).mock.calls;
    for (const call of calls) expect(call[4]).toBe(knownForSeven);
  });

  it('passes an empty property map for a page it has just created', async () => {
    const d = deps();
    await executePlan(client, {
      plan: planFor(['docs/a.md']), spaceId: '42', versionMessage: 'm', concurrency: 1,
      footer: null, index: new Map(),
    }, d);
    const calls = vi.mocked(d.writeProperty).mock.calls;
    expect(calls[0]![4]).toBeInstanceOf(Map);
    expect(calls[0]![4]!.size).toBe(0);
  });

  it('reports an update as moved when the plan asked for a move', async () => {
    const d = deps();
    const plan = planFor(['docs/a.md']);
    plan.pages[0]!.action = 'move';
    plan.pages[0]!.pageId = '7';
    const result = await executePlan(client, { plan, spaceId: '42', versionMessage: 'm', concurrency: 1, footer: null, index: new Map() }, d);
    expect(result.outcomes[0]!.kind).toBe('moved');
    expect(d.updatePage).toHaveBeenCalledTimes(1);
  });

  // buildPlan computes each page's contentHash against expectedParentId, which is null for a
  // leaf whose container does not exist yet (the container's own pageId is unknown at plan
  // time). If publish() persisted that plan-time hash verbatim, the leaf would compare unequal
  // to itself forever afterwards (real parent id vs. null) and reclassify as 'update' on every
  // subsequent run. This test pins that the hash actually written is recomputed against the
  // real, resolved parent id of the freshly created container.
  it('writes a content-hash computed against the real resolved parent, not the plan-time value, for a leaf under a freshly created container', async () => {
    const d = deps();
    const plan = planFor(['docs/sub/a.md']);
    const leaf = plan.pages.find((p) => p.node.sourcePath === 'docs/sub/a.md')!;
    const planTimeHash = leaf.contentHash;
    // Sanity check on the premise: at plan time the container did not exist, so
    // expectedParentId (and therefore the hash) was computed against a null parent.
    expect(leaf.expectedParentId).toBeNull();

    const result = await executePlan(client, {
      plan, spaceId: '42', versionMessage: 'm', concurrency: 2, footer: null, index: new Map(),
    }, d);

    const container = result.outcomes.find((o) => o.sourcePath === 'docs/sub/')!;
    const realParentId = container.pageId as string;
    const expectedRealHash = computeContentHash(leaf.node.title, realParentId, leaf.storage);
    expect(expectedRealHash).not.toBe(planTimeHash);

    const leafPageId = `new-${leaf.node.title}`;
    const hashCall = vi.mocked(d.writeProperty).mock.calls.find(
      (c) => c[2] === PROPERTY_KEYS.contentHash && c[1] === leafPageId,
    );
    expect(hashCall![3]).toBe(expectedRealHash);
    expect(hashCall![3]).not.toBe(planTimeHash);
  });
});
