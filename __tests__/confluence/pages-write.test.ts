import { describe, expect, it } from 'vitest';
import { ConfluenceClient } from '../../src/confluence/client.js';
import { createPage, updatePage, writeProperty } from '../../src/confluence/pages.js';

interface Call { method: string; path: string; body: unknown }

const clientFor = (handler: (call: Call) => Response, calls: Call[] = []) => ({
  calls,
  client: new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    username: 'u@acme.com',
    apiToken: 'tok',
    requestTimeoutMs: 1000,
    maxRetries: 0,
    sleep: async () => {},
    // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
    fetchImpl: async (input, init) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- test doubles only ever pass a URL or string here
      const path = new URL(String(input)).pathname;
      const call: Call = {
        method: init?.method ?? 'GET',
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
    },
  }),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createPage', () => {
  it('posts the v2 payload and returns the new page', async () => {
    const { client, calls } = clientFor(() => json({ id: '5', title: 'T', status: 'current', parentId: '1', spaceId: '42' }));
    const page = await createPage(client, { spaceId: '42', title: 'T', parentId: '1', storage: '<p>x</p>' });
    expect(page.id).toBe('5');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/wiki/api/v2/pages',
      body: { spaceId: '42', status: 'current', title: 'T', parentId: '1', body: { representation: 'storage', value: '<p>x</p>' } },
    });
  });
});

describe('updatePage', () => {
  it('reads the current version and sends current + 1', async () => {
    const { client, calls } = clientFor((call) =>
      call.method === 'GET'
        ? json({ id: '5', title: 'T', status: 'current', parentId: '1', spaceId: '42', version: { number: 7 } })
        : json({ id: '5', title: 'T2', status: 'current', parentId: '2', spaceId: '42' }),
    );
    await updatePage(client, { pageId: '5', title: 'T2', parentId: '2', storage: '<p>y</p>', versionMessage: 'msg' });
    expect(calls[1]!.body).toMatchObject({ version: { number: 8, message: 'msg' }, parentId: '2' });
  });

  it('re-reads and retries exactly once on 409', async () => {
    let version = 7;
    let puts = 0;
    const { client, calls } = clientFor((call) => {
      if (call.method === 'GET') return json({ id: '5', title: 'T', status: 'current', parentId: '1', spaceId: '42', version: { number: version } });
      puts += 1;
      if (puts === 1) {
        version = 9;
        return json({ message: 'version conflict' }, 409);
      }
      return json({ id: '5', title: 'T', status: 'current', parentId: '1', spaceId: '42' });
    });
    await expect(
      updatePage(client, { pageId: '5', title: 'T', parentId: '1', storage: '<p>y</p>', versionMessage: 'msg' }),
    ).resolves.toMatchObject({ id: '5' });
    expect(puts).toBe(2);
    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(2);
    // version 7 -> PUT 8 -> 409 -> re-read 9 -> PUT 10
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      body: { version: { number: 10 } },
    });
  });

  it('propagates a second 409 instead of looping', async () => {
    const { client, calls } = clientFor((call) =>
      call.method === 'GET'
        ? json({ id: '5', title: 'T', status: 'current', parentId: '1', spaceId: '42', version: { number: 7 } })
        : json({ message: 'conflict' }, 409),
    );
    await expect(
      updatePage(client, { pageId: '5', title: 'T', parentId: '1', storage: '<p>y</p>', versionMessage: 'm' }),
    ).rejects.toMatchObject({ status: 409 });
    // The rejection alone does not distinguish one retry from a loop — a nested second retry
    // would reject with a 409 just the same. The attempt count is what bounds it.
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  // The retry is narrowed to a 409 ConfluenceHttpError. Dropping either half of that test
  // would turn a hard failure into a second write attempt — the mutant these two kill.
  it.each([404, 500])('propagates an HTTP %i without a second attempt', async (status) => {
    const { client, calls } = clientFor((call) =>
      call.method === 'GET'
        ? json({ id: '5', title: 'T', status: 'current', parentId: '1', spaceId: '42', version: { number: 7 } })
        : json({ message: 'nope' }, status),
    );
    await expect(
      updatePage(client, { pageId: '5', title: 'T', parentId: '1', storage: '<p>y</p>', versionMessage: 'm' }),
    ).rejects.toMatchObject({ status });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  // The thrown error deliberately carries `status: 409`: it is still not a ConfluenceHttpError,
  // so the retry must not fire. This is what kills the mutant that drops the `instanceof` test.
  it('propagates a non-HTTP failure unchanged, without a second attempt', async () => {
    const boom = Object.assign(new Error('socket hang up'), { status: 409 });
    const { client, calls } = clientFor((call) => {
      if (call.method === 'GET') {
        return json({ id: '5', title: 'T', status: 'current', parentId: '1', spaceId: '42', version: { number: 7 } });
      }
      throw boom;
    });
    await expect(
      updatePage(client, { pageId: '5', title: 'T', parentId: '1', storage: '<p>y</p>', versionMessage: 'm' }),
    ).rejects.toBe(boom);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});

describe('writeProperty', () => {
  it('creates the property when the page carries none with that key', async () => {
    const { client, calls } = clientFor((call) =>
      call.method === 'GET' ? json({ results: [], _links: {} }) : json({ id: '77' }),
    );
    await writeProperty(client, '5', 'confluence-docs-publisher.source-path', 'docs/a.md');
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/wiki/api/v2/pages/5/properties',
      body: { key: 'confluence-docs-publisher.source-path', value: 'docs/a.md' },
    });
  });

  it('updates the property by its numeric id, bumping the version', async () => {
    const known = new Map([['k', { propertyId: '77', version: 4, value: 'old' }]]);
    const { client, calls } = clientFor(() => json({ id: '77' }));
    await writeProperty(client, '5', 'k', 'new', known);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/wiki/api/v2/pages/5/properties/77',
      body: { key: 'k', value: 'new', version: { number: 5 } },
    });
  });

  it('skips the write when the stored value already matches', async () => {
    const known = new Map([['k', { propertyId: '77', version: 4, value: 'same' }]]);
    const { client, calls } = clientFor(() => json({}));
    await writeProperty(client, '5', 'k', 'same', known);
    expect(calls).toHaveLength(0);
  });

  it('does not read properties when an empty known map is given', async () => {
    const known = new Map<string, { propertyId: string; version: number; value: unknown }>();
    const { client, calls } = clientFor(() => json({ id: '77' }));
    await writeProperty(client, '5', 'confluence-docs-publisher.source-path', 'docs/a.md', known);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/wiki/api/v2/pages/5/properties' });
  });

  // Same optimistic-locking hazard updatePage already handles: `known` is captured once, by the
  // index scan at the start of the run, so a concurrent run that bumps the property version turns
  // an otherwise successful publish into a reported failure.
  it('re-reads and retries exactly once on 409', async () => {
    const known = new Map([['k', { propertyId: '77', version: 4, value: 'old' }]]);
    let puts = 0;
    const { client, calls } = clientFor((call) => {
      if (call.method === 'GET') {
        return json({ results: [{ id: '77', key: 'k', value: 'old', version: { number: 9 } }], _links: {} });
      }
      puts += 1;
      if (puts === 1) return json({ message: 'version conflict' }, 409);
      return json({ id: '77' });
    });
    await expect(writeProperty(client, '5', 'k', 'new', known)).resolves.toBeUndefined();
    expect(puts).toBe(2);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    // stale version 4 -> PUT 5 -> 409 -> re-read 9 -> PUT 10
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/wiki/api/v2/pages/5/properties/77',
      body: { key: 'k', value: 'new', version: { number: 10 } },
    });
  });

  it('propagates a second 409 instead of looping', async () => {
    const known = new Map([['k', { propertyId: '77', version: 4, value: 'old' }]]);
    let puts = 0;
    const { client } = clientFor((call) => {
      if (call.method === 'GET') {
        return json({ results: [{ id: '77', key: 'k', value: 'old', version: { number: 9 } }], _links: {} });
      }
      puts += 1;
      return json({ message: 'version conflict' }, 409);
    });
    await expect(writeProperty(client, '5', 'k', 'new', known)).rejects.toMatchObject({ status: 409 });
    expect(puts).toBe(2);
  });

  it('propagates the 409 when the property has disappeared by the time it re-reads', async () => {
    const known = new Map([['k', { propertyId: '77', version: 4, value: 'old' }]]);
    let puts = 0;
    const { client } = clientFor((call) => {
      if (call.method === 'GET') return json({ results: [], _links: {} });
      puts += 1;
      return json({ message: 'version conflict' }, 409);
    });
    await expect(writeProperty(client, '5', 'k', 'new', known)).rejects.toMatchObject({ status: 409 });
    expect(puts).toBe(1);
  });

  // Same narrowing as updatePage's, and the matching pair of mutants. A non-409 must never
  // reach the re-read, let alone a second PUT.
  it.each([404, 500])('propagates an HTTP %i without re-reading or retrying', async (status) => {
    const known = new Map([['k', { propertyId: '77', version: 4, value: 'old' }]]);
    const { client, calls } = clientFor((call) => {
      if (call.method === 'GET') return json({ results: [{ id: '77', key: 'k', value: 'old', version: { number: 9 } }], _links: {} });
      return json({ message: 'nope' }, status);
    });
    await expect(writeProperty(client, '5', 'k', 'new', known)).rejects.toMatchObject({ status });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  // As above: a 409-shaped `status` on an error that is not a ConfluenceHttpError must not be
  // enough to trigger the re-read and retry.
  it('propagates a non-HTTP failure unchanged, without re-reading or retrying', async () => {
    const known = new Map([['k', { propertyId: '77', version: 4, value: 'old' }]]);
    const boom = Object.assign(new Error('socket hang up'), { status: 409 });
    const { client, calls } = clientFor((call) => {
      if (call.method === 'GET') return json({ results: [{ id: '77', key: 'k', value: 'old', version: { number: 9 } }], _links: {} });
      throw boom;
    });
    await expect(writeProperty(client, '5', 'k', 'new', known)).rejects.toBe(boom);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0);
  });

  it('still reads properties when known is omitted entirely', async () => {
    const { client, calls } = clientFor((call) =>
      call.method === 'GET' ? json({ results: [], _links: {} }) : json({ id: '77' }),
    );
    await writeProperty(client, '5', 'confluence-docs-publisher.source-path', 'docs/a.md');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });
});
