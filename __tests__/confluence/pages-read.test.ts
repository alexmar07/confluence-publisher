import { describe, expect, it } from 'vitest';
import { ConfluenceClient } from '../../src/confluence/client.js';
import {
  buildIndex, findPagesByTitle, getPage, isFolder, listDescendants, readProperties, resolveSpaceId,
} from '../../src/confluence/pages.js';

type Route = (url: URL, init: RequestInit | undefined) => Response;

const clientFor = (routes: Record<string, Route>) =>
  new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    username: 'u@acme.com',
    apiToken: 'tok',
    requestTimeoutMs: 1000,
    maxRetries: 0,
    sleep: async () => {},
    // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
    fetchImpl: async (input, init) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- test doubles only ever pass a URL or string here
      const url = new URL(String(input));
      const key = Object.keys(routes).find((k) => url.pathname === k);
      if (!key) return new Response('', { status: 404 });
      return routes[key]!(url, init);
    },
  });

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('resolveSpaceId', () => {
  it('returns the id of the matching space', async () => {
    const client = clientFor({ '/wiki/api/v2/spaces': () => json({ results: [{ id: '42', key: 'DOC' }] }) });
    await expect(resolveSpaceId(client, 'DOC')).resolves.toBe('42');
  });

  it('returns null when no space matches', async () => {
    const client = clientFor({ '/wiki/api/v2/spaces': () => json({ results: [] }) });
    await expect(resolveSpaceId(client, 'NOPE')).resolves.toBeNull();
  });
});

describe('getPage and isFolder', () => {
  it('returns the page summary including its space id', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages/9': () => json({ id: '9', title: 'T', status: 'current', parentId: '1', spaceId: '42' }),
    });
    await expect(getPage(client, '9')).resolves.toEqual({
      id: '9', title: 'T', status: 'current', parentId: '1', spaceId: '42',
    });
  });

  it('returns null on 404 instead of throwing', async () => {
    const client = clientFor({});
    await expect(getPage(client, '9')).resolves.toBeNull();
  });

  it('reports whether the content id is a folder', async () => {
    const client = clientFor({ '/wiki/api/v2/folders/9': () => json({ id: '9', type: 'folder' }) });
    await expect(isFolder(client, '9')).resolves.toBe(true);
    await expect(isFolder(clientFor({}), '9')).resolves.toBe(false);
  });
});

describe('findPagesByTitle', () => {
  it('passes the requested statuses as a comma separated list', async () => {
    let seen = '';
    const client = clientFor({
      '/wiki/api/v2/pages': (url) => {
        seen = url.searchParams.get('status') ?? '';
        return json({ results: [{ id: '3', title: 'T', status: 'archived' }] });
      },
    });
    const found = await findPagesByTitle(client, '42', 'T', ['current', 'archived', 'trashed']);
    expect(seen).toBe('current,archived,trashed');
    expect(found).toHaveLength(1);
  });
});

describe('listDescendants', () => {
  it('follows the cursor and keeps only pages', async () => {
    let call = 0;
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': () => {
        call += 1;
        return call === 1
          ? json({
              results: [
                { id: '2', title: 'A', status: 'current', type: 'page', parentId: '1' },
                { id: '3', title: 'F', status: 'current', type: 'folder', parentId: '1' },
              ],
              _links: { next: '/wiki/api/v2/pages/1/descendants?cursor=x' },
            })
          : json({ results: [{ id: '4', title: 'B', status: 'archived', type: 'page', parentId: '2' }], _links: {} });
      },
    });
    const found = await listDescendants(client, '1', 5);
    expect(found.map((p) => p.id)).toEqual(['2', '4']);
  });

  it('walks by successive levels when the requested depth exceeds the API maximum', async () => {
    const requested: (string | null)[] = [];
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': (url) => {
        requested.push(url.searchParams.get('depth'));
        return json({
          results: [
            { id: '2', title: 'A', status: 'current', type: 'page', parentId: '1', depth: 1 },
            { id: '3', title: 'B', status: 'current', type: 'page', parentId: '2', depth: 10 },
          ],
          _links: {},
        });
      },
      '/wiki/api/v2/pages/3/descendants': (url) => {
        requested.push(url.searchParams.get('depth'));
        return json({
          results: [{ id: '4', title: 'C', status: 'current', type: 'page', parentId: '3', depth: 1 }],
          _links: {},
        });
      },
    });
    const found = await listDescendants(client, '1', 13);
    expect(requested).toEqual(['10', '3']);
    expect(found.map((p) => p.id)).toEqual(['2', '3', '4']);
  });

  it('does not walk further when the requested depth fits in one call', async () => {
    let calls = 0;
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': () => {
        calls += 1;
        return json({
          results: [{ id: '2', title: 'A', status: 'current', type: 'page', parentId: '1', depth: 10 }],
          _links: {},
        });
      },
    });
    await listDescendants(client, '1', 10);
    expect(calls).toBe(1);
  });

  it('fails loudly when a deeper walk is required but the API omits per-item depth', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': () =>
        json({
          results: [{ id: '2', title: 'A', status: 'current', type: 'page', parentId: '1' }],
          _links: {},
        }),
    });
    await expect(listDescendants(client, '1', 11)).rejects.toThrow(
      'The descendants response carries no per-item depth; the tree cannot be walked safely beyond depth 10',
    );
  });

  it('walks normally when at least one item carries a depth even if others omit it', async () => {
    const requested: (string | null)[] = [];
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': (url) => {
        requested.push(url.searchParams.get('depth'));
        return json({
          results: [
            { id: '2', title: 'A', status: 'current', type: 'page', parentId: '1' },
            { id: '3', title: 'B', status: 'current', type: 'page', parentId: '2', depth: 10 },
          ],
          _links: {},
        });
      },
      '/wiki/api/v2/pages/3/descendants': (url) => {
        requested.push(url.searchParams.get('depth'));
        return json({
          results: [{ id: '4', title: 'C', status: 'current', type: 'page', parentId: '3' }],
          _links: {},
        });
      },
    });
    const found = await listDescendants(client, '1', 13);
    expect(requested).toEqual(['10', '3']);
    expect(found.map((p) => p.id)).toEqual(['2', '3', '4']);
  });
});

describe('readProperties', () => {
  it('maps every property key to its id, version and value', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages/9/properties': () =>
        json({
          results: [
            { id: '100', key: 'confluence-docs-publisher.source-path', value: 'docs/a.md', version: { number: 3 } },
          ],
          _links: {},
        }),
    });
    const props = await readProperties(client, '9');
    expect(props.get('confluence-docs-publisher.source-path')).toEqual({
      propertyId: '100', version: 3, value: 'docs/a.md',
    });
  });
});

describe('buildIndex', () => {
  const descendants = {
    '/wiki/api/v2/pages/1/descendants': () =>
      json({
        results: [
          { id: '2', title: 'Tracked', status: 'current', type: 'page', parentId: '1' },
          { id: '3', title: 'Stray', status: 'current', type: 'page', parentId: '1' },
          { id: '4', title: 'Old', status: 'archived', type: 'page', parentId: '1' },
        ],
        _links: {},
      }),
  };

  const props: Record<string, Route> = {
    '/wiki/api/v2/pages/2/properties': () =>
      json({
        results: [
          { id: '10', key: 'confluence-docs-publisher.source-path', value: 'docs/a.md', version: { number: 1 } },
          { id: '11', key: 'confluence-docs-publisher.content-hash', value: 'h1', version: { number: 1 } },
        ],
        _links: {},
      }),
    '/wiki/api/v2/pages/3/properties': () => json({ results: [], _links: {} }),
    '/wiki/api/v2/pages/4/properties': () =>
      json({
        results: [{ id: '12', key: 'confluence-docs-publisher.source-path', value: 'docs/b.md', version: { number: 1 } }],
        _links: {},
      }),
  };

  it('maps tracked pages by source-path and collects the untracked ones', async () => {
    const client = clientFor({ ...descendants, ...props });
    const index = await buildIndex(client, '1', 3, 2);
    expect(index.bySourcePath.get('docs/a.md')).toMatchObject({ pageId: '2', contentHash: 'h1' });
    expect(index.unmanaged.map((e) => e.pageId)).toEqual(['3']);
  });

  it('excludes non-current pages from the map and reports them as archived conflicts', async () => {
    const client = clientFor({ ...descendants, ...props });
    const seen: string[] = [];
    const index = await buildIndex(client, '1', 3, 2, (page) => seen.push(`${page.title}:${page.status}`));
    expect(index.bySourcePath.has('docs/b.md')).toBe(false);
    expect(seen).toEqual(['Old:archived']);
  });

  it('reads the synthetic flag and the attachment hashes', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': () =>
        json({ results: [{ id: '5', title: 'C', status: 'current', type: 'page', parentId: '1' }], _links: {} }),
      '/wiki/api/v2/pages/5/properties': () =>
        json({
          results: [
            { id: '20', key: 'confluence-docs-publisher.source-path', value: 'docs/sub/', version: { number: 1 } },
            { id: '21', key: 'confluence-docs-publisher.synthetic', value: true, version: { number: 1 } },
            { id: '22', key: 'confluence-docs-publisher.attachment-hashes', value: { 'a.png': 'abc' }, version: { number: 1 } },
          ],
          _links: {},
        }),
    });
    const index = await buildIndex(client, '1', 3, 2);
    expect(index.bySourcePath.get('docs/sub/')).toMatchObject({
      synthetic: true,
      attachmentHashes: { 'a.png': 'abc' },
    });
  });

  it('hands back the properties already read, so later writes need no extra lookup', async () => {
    const client = clientFor({ ...descendants, ...props });
    const index = await buildIndex(client, '1', 3, 2);
    expect(index.propertiesByPageId.get('2')!.get('confluence-docs-publisher.content-hash')).toEqual({
      propertyId: '11',
      version: 1,
      value: 'h1',
    });
    expect(index.propertiesByPageId.get('3')!.size).toBe(0);
  });

  it('merges attachment hashes spread across numbered property chunks', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': () =>
        json({
          results: [{ id: '8', title: 'D', status: 'current', type: 'page', parentId: '1' }],
          _links: {},
        }),
      '/wiki/api/v2/pages/8/properties': () =>
        json({
          results: [
            {
              id: '40',
              key: 'confluence-docs-publisher.source-path',
              value: 'docs/many-attachments/',
              version: { number: 1 },
            },
            {
              id: '41',
              key: 'confluence-docs-publisher.attachment-hashes',
              value: { 'a.png': 'aaa' },
              version: { number: 1 },
            },
            {
              id: '42',
              key: 'confluence-docs-publisher.attachment-hashes.2',
              value: { 'b.png': 'bbb' },
              version: { number: 1 },
            },
          ],
          _links: {},
        }),
    });
    const index = await buildIndex(client, '1', 3, 2);
    expect(index.bySourcePath.get('docs/many-attachments/')).toMatchObject({
      attachmentHashes: { 'a.png': 'aaa', 'b.png': 'bbb' },
    });
  });

  it('routes the losing entry to unmanaged and reports the collision when two current pages share a source-path', async () => {
    const client = clientFor({
      '/wiki/api/v2/pages/1/descendants': () =>
        json({
          results: [
            { id: '6', title: 'First', status: 'current', type: 'page', parentId: '1' },
            { id: '7', title: 'Second', status: 'current', type: 'page', parentId: '1' },
          ],
          _links: {},
        }),
      '/wiki/api/v2/pages/6/properties': () =>
        json({
          results: [
            { id: '30', key: 'confluence-docs-publisher.source-path', value: 'docs/dup.md', version: { number: 1 } },
          ],
          _links: {},
        }),
      '/wiki/api/v2/pages/7/properties': () =>
        json({
          results: [
            { id: '31', key: 'confluence-docs-publisher.source-path', value: 'docs/dup.md', version: { number: 1 } },
          ],
          _links: {},
        }),
    });
    const conflicts: { page: string; previous: string }[] = [];
    const index = await buildIndex(client, '1', 3, 2, undefined, (page, previous) => {
      conflicts.push({ page: page.id, previous: previous.pageId });
    });
    expect(index.bySourcePath.get('docs/dup.md')).toMatchObject({ pageId: '7' });
    expect(index.unmanaged.map((e) => e.pageId)).toEqual(['6']);
    expect(conflicts).toEqual([{ page: '7', previous: '6' }]);
  });
});
