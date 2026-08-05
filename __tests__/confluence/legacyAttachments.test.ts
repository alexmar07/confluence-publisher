import { describe, expect, it } from 'vitest';
import { ConfluenceClient } from '../../src/confluence/client.js';
import {
  attachmentHash, attachmentsToUpload, chunkAttachmentHashes, listAttachments, uploadAttachment,
} from '../../src/confluence/legacyAttachments.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

// `typeof fetch`'s first parameter is `string | URL | Request`; Request's inherited
// `toString()` isn't meaningful, so narrow explicitly instead of coercing with `String()`.
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

describe('attachmentsToUpload', () => {
  it('selects the files whose hash differs from the stored one', () => {
    const local = new Map([['a.png', 'h1'], ['b.png', 'h2'], ['c.png', 'h3']]);
    expect(attachmentsToUpload(local, { 'a.png': 'h1', 'b.png': 'old' })).toEqual(['b.png', 'c.png']);
  });

  it('selects everything when no hash has ever been stored', () => {
    expect(attachmentsToUpload(new Map([['a.png', 'h']]), {})).toEqual(['a.png']);
  });

  it('is stable for a page whose attachments are unchanged', () => {
    expect(attachmentsToUpload(new Map([['a.png', 'h']]), { 'a.png': 'h' })).toEqual([]);
  });
});

describe('attachmentHash', () => {
  it('hashes the bytes, not the reference', () => {
    expect(attachmentHash(new Uint8Array([1, 2, 3]))).toBe(attachmentHash(new Uint8Array([1, 2, 3])));
    expect(attachmentHash(new Uint8Array([1, 2, 3]))).not.toBe(attachmentHash(new Uint8Array([1, 2, 4])));
  });

  it('uses the compact base64url representation of the sha256 digest', () => {
    const hash = attachmentHash(new Uint8Array([1, 2, 3]));
    expect(hash).toHaveLength(43);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes an empty file to the sha256 digest of zero bytes, not an error or empty string', () => {
    const hash = attachmentHash(new Uint8Array());
    expect(hash).toHaveLength(43);
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('chunkAttachmentHashes', () => {
  it('keeps a small map in a single chunk', () => {
    expect(chunkAttachmentHashes(new Map([['a.png', 'h1'], ['b.png', 'h2']]))).toEqual([
      { 'a.png': 'h1', 'b.png': 'h2' },
    ]);
  });

  it('splits a map that would exceed the property size limit', () => {
    const many = new Map(
      Array.from({ length: 40 }, (_, i) => [`file-${String(i).padStart(3, '0')}.png`, 'x'.repeat(43)] as const),
    );
    const chunks = chunkAttachmentHashes(many, 512);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThanOrEqual(512);
    }
    expect(Object.assign({}, ...chunks)).toEqual(Object.fromEntries(many));
  });

  it('returns a single empty chunk for an empty map, so stale values get overwritten', () => {
    expect(chunkAttachmentHashes(new Map())).toEqual([{}]);
  });

  // Accepted degenerate case, not an oversight: a single entry that alone exceeds `limitBytes`
  // cannot be split further (a key cannot be divided) and must not be dropped (that would lose
  // state), so it ships alone in its own chunk even though that chunk exceeds the limit.
  it('ships a single entry alone, over limit, when its own JSON already exceeds limitBytes', () => {
    const oversized = new Map([['huge.png', 'x'.repeat(100)]]);
    const chunks = chunkAttachmentHashes(oversized, 10);
    expect(chunks).toEqual([{ 'huge.png': 'x'.repeat(100) }]);
    expect(Buffer.byteLength(JSON.stringify(chunks[0]), 'utf8')).toBeGreaterThan(10);
  });

  it('produces byte-identical serialisation regardless of the input map insertion order', () => {
    // `toEqual` is key-order-insensitive and would pass even without the sort; writeProperty
    // (src/confluence/pages.ts) gates on `JSON.stringify` equality, so the property that
    // actually matters here is the serialised string, asserted directly.
    const forward = new Map([['a.png', 'h1'], ['b.png', 'h2'], ['c.png', 'h3']]);
    const backward = new Map([['c.png', 'h3'], ['a.png', 'h1'], ['b.png', 'h2']]);
    expect(JSON.stringify(chunkAttachmentHashes(forward))).toBe(JSON.stringify(chunkAttachmentHashes(backward)));
  });
});

describe('listAttachments', () => {
  it('reads attachments through the v2 endpoint', async () => {
    let path = '';
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net', username: 'u@a.com', apiToken: 'tok',
      requestTimeoutMs: 1000, maxRetries: 0, sleep: async () => {},
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      fetchImpl: async (input) => {
        path = new URL(urlOf(input)).pathname;
        return json({ results: [{ id: 'att1', title: 'a.png' }], _links: {} });
      },
    });
    await expect(listAttachments(client, '5')).resolves.toEqual([{ id: 'att1', title: 'a.png' }]);
    expect(path).toBe('/wiki/api/v2/pages/5/attachments');
  });
});

describe('uploadAttachment', () => {
  it('creates via the v1 endpoint when no attachment with that filename exists yet', async () => {
    const requests: { path: string; headers: Headers; body: unknown }[] = [];
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net', username: 'u@a.com', apiToken: 'tok',
      requestTimeoutMs: 1000, maxRetries: 0, sleep: async () => {},
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      fetchImpl: async (input, init) => {
        requests.push({ path: new URL(urlOf(input)).pathname, headers: new Headers(init?.headers), body: init?.body });
        if (requests.length === 1) return json({ results: [{ id: 'att9', title: 'other.png' }], _links: {} });
        return json({ results: [{ id: 'att1' }] });
      },
    });
    await uploadAttachment(client, '5', 'a.png', new Uint8Array([1, 2, 3]));

    expect(requests).toHaveLength(2);
    expect(requests[0]!.path).toBe('/wiki/api/v2/pages/5/attachments');
    expect(requests[1]!.path).toBe('/wiki/rest/api/content/5/child/attachment');
    expect(requests[1]!.headers.get('x-atlassian-token')).toBe('no-check');
    expect(requests[1]!.body).toBeInstanceOf(FormData);
    expect((requests[1]!.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect((requests[1]!.body as FormData).get('minorEdit')).toBe('true');
  });

  it('updates the existing attachment via its /data endpoint when the filename is already present', async () => {
    const requests: { path: string; headers: Headers; body: unknown }[] = [];
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net', username: 'u@a.com', apiToken: 'tok',
      requestTimeoutMs: 1000, maxRetries: 0, sleep: async () => {},
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      fetchImpl: async (input, init) => {
        requests.push({ path: new URL(urlOf(input)).pathname, headers: new Headers(init?.headers), body: init?.body });
        if (requests.length === 1) {
          return json({ results: [{ id: 'att9', title: 'other.png' }, { id: 'att42', title: 'diagram.png' }], _links: {} });
        }
        return json({ id: 'att42' });
      },
    });
    await uploadAttachment(client, '5', 'diagram.png', new Uint8Array([1, 2, 3]));

    expect(requests).toHaveLength(2);
    expect(requests[0]!.path).toBe('/wiki/api/v2/pages/5/attachments');
    expect(requests[1]!.path).toBe('/wiki/rest/api/content/5/child/attachment/att42/data');
    expect(requests[1]!.headers.get('x-atlassian-token')).toBe('no-check');
    expect(requests[1]!.body).toBeInstanceOf(FormData);
    expect((requests[1]!.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect((requests[1]!.body as FormData).get('minorEdit')).toBe('true');
  });
});
