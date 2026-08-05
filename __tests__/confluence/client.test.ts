import { describe, expect, it } from 'vitest';
import { ConfluenceClient, ConfluenceHttpError, redact } from '../../src/confluence/client.js';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

// `typeof fetch`'s first parameter is `string | URL | Request`; Request's inherited
// `toString()` isn't meaningful, so narrow explicitly instead of coercing with `String()`.
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const make = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof ConfluenceClient>[0]> = {}) =>
  new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    username: 'user@acme.com',
    apiToken: 'sekret',
    requestTimeoutMs: 1000,
    maxRetries: 3,
    fetchImpl,
    sleep: async () => {},
    ...over,
  });

describe('authentication and request shape', () => {
  it('sends basic auth built from username and token', async () => {
    const calls: Request[] = [];
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async (input, init) => {
        calls.push(new Request(input, init));
        return json({ ok: true });
      },
    );
    await client.request('GET', '/wiki/api/v2/spaces');
    const header = calls[0]!.headers.get('authorization');
    expect(header).toBe(`Basic ${Buffer.from('user@acme.com:sekret').toString('base64')}`);
  });

  it('appends query parameters and skips undefined ones', async () => {
    let seen = '';
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async (input) => {
        seen = urlOf(input);
        return json({});
      },
    );
    await client.request('GET', '/wiki/api/v2/pages', { query: { 'space-id': 7, title: 'a b', cursor: undefined } });
    expect(seen).toBe('https://acme.atlassian.net/wiki/api/v2/pages?space-id=7&title=a+b');
  });

  it('serialises the body as json', async () => {
    let body = '';
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async (_input, init) => {
        body = typeof init?.body === 'string' ? init.body : '';
        return json({});
      },
    );
    await client.request('POST', '/x', { body: { title: 'T' } });
    expect(body).toBe('{"title":"T"}');
  });
});

describe('retry policy', () => {
  it('retries on 429 honouring a numeric Retry-After', async () => {
    const delays: number[] = [];
    let attempt = 0;
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async () => {
        attempt += 1;
        return attempt === 1
          ? new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
          : json({ ok: true });
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- records the delay synchronously, no real wait needed in tests
      { sleep: async (ms) => void delays.push(ms) },
    );
    await expect(client.request('GET', '/x')).resolves.toEqual({ ok: true });
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
  });

  it('honours an HTTP-date Retry-After', async () => {
    const delays: number[] = [];
    let attempt = 0;
    const future = new Date(Date.now() + 3000).toUTCString();
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async () => {
        attempt += 1;
        return attempt === 1
          ? new Response('', { status: 429, headers: { 'retry-after': future } })
          : json({ ok: true });
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- records the delay synchronously, no real wait needed in tests
      { sleep: async (ms) => void delays.push(ms) },
    );
    await client.request('GET', '/x');
    expect(delays[0]).toBeGreaterThan(1000);
  });

  it('retries on 502, 503 and 504', async () => {
    for (const status of [502, 503, 504]) {
      let attempt = 0;
      const client = make(
        // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
        async () => {
          attempt += 1;
          return attempt === 1 ? new Response('', { status }) : json({ ok: true });
        },
      );
      await expect(client.request('GET', '/x')).resolves.toEqual({ ok: true });
      expect(attempt).toBe(2);
    }
  });

  it('retries on a network error', async () => {
    let attempt = 0;
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- throws or returns synchronously by design
      async () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError('fetch failed');
        return json({ ok: true });
      },
    );
    await expect(client.request('GET', '/x')).resolves.toEqual({ ok: true });
  });

  it('does not retry a 400 and surfaces the response body', async () => {
    let attempt = 0;
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async () => {
        attempt += 1;
        return new Response('Invalid XHTML near line 3', { status: 400 });
      },
    );
    await expect(client.request('GET', '/x')).rejects.toMatchObject({
      status: 400,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest's asymmetric matchers are typed as `any`
      body: expect.stringContaining('Invalid XHTML'),
    });
    expect(attempt).toBe(1);
  });

  it('does not retry a 404', async () => {
    let attempt = 0;
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async () => {
        attempt += 1;
        return new Response('', { status: 404 });
      },
    );
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(ConfluenceHttpError);
    expect(attempt).toBe(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    let attempt = 0;
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async () => {
        attempt += 1;
        return new Response('', { status: 503 });
      },
      { maxRetries: 2 },
    );
    await expect(client.request('GET', '/x')).rejects.toMatchObject({ status: 503 });
    expect(attempt).toBe(3);
  });

  it('aborts a request that exceeds the timeout and retries it', async () => {
    let attempt = 0;
    const client = make(async (_input, init) => {
      attempt += 1;
      if (attempt === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return json({ ok: true });
    }, { requestTimeoutMs: 10 });
    await expect(client.request('GET', '/x')).resolves.toEqual({ ok: true });
  });
});

describe('pagination', () => {
  it('follows _links.next until it is absent', async () => {
    const pages = [
      json({ results: [{ id: '1' }], _links: { next: '/wiki/api/v2/pages?cursor=abc' } }),
      json({ results: [{ id: '2' }], _links: {} }),
    ];
    const seen: string[] = [];
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async (input) => {
        seen.push(urlOf(input));
        return pages.shift() ?? json({ results: [] });
      },
    );
    const out: { id: string }[] = [];
    for await (const item of client.paginate<{ id: string }>('/wiki/api/v2/pages', { limit: 250 })) out.push(item);
    expect(out.map((i) => i.id)).toEqual(['1', '2']);
    expect(seen[1]).toBe('https://acme.atlassian.net/wiki/api/v2/pages?cursor=abc');
  });
});

describe('secret redaction', () => {
  it('replaces every occurrence of each secret', () => {
    expect(redact('token=sekret user=user@acme.com', ['sekret', 'user@acme.com'])).toBe('token=*** user=***');
  });

  // The four-character floor is load-bearing for a security function, so both sides of it
  // are pinned here.
  it('redacts a secret exactly at the four-character floor', () => {
    const out = redact('see abcd here', ['abcd']);
    expect(out).toContain('***');
    expect(out).not.toContain('abcd');
  });

  it('leaves a three-character secret alone', () => {
    expect(redact('see abc here', ['abc'])).toBe('see abc here');
  });

  it('redacts secrets appearing in an error body', async () => {
    const client = make(
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a pre-built Response synchronously
      async () => new Response('bad credentials for user@acme.com', { status: 401 }),
    );
    await expect(client.request('GET', '/x')).rejects.toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest's asymmetric matchers are typed as `any`
      body: expect.not.stringContaining('user@acme.com'),
    });
  });
});
