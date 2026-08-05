import { beforeAll, describe, expect, it } from 'vitest';
import { ConfluenceClient, ConfluenceHttpError } from '../../src/confluence/client.js';

const BASE_URL = process.env.WIREMOCK_URL ?? 'http://localhost:8080';

const client = new ConfluenceClient({
  baseUrl: BASE_URL,
  username: 'u@acme.com',
  apiToken: 'tok',
  requestTimeoutMs: 10_000,
  maxRetries: 3,
});

beforeAll(async () => {
  const response = await fetch(`${BASE_URL}/__admin/mappings`);
  expect(response.ok).toBe(true);
  // Stateful scenarios keep their state between runs: without this reset a second
  // invocation would find the rate limiter already recovered and exercise no retry.
  await fetch(`${BASE_URL}/__admin/scenarios/reset`, { method: 'POST' });
});

describe('client against the simulator', () => {
  it('reads a json payload through the v2 space endpoint', async () => {
    const body = await client.request<{ results: { id: string }[] }>('GET', '/wiki/api/v2/spaces', {
      query: { keys: 'DOC' },
    });
    expect(body.results[0]!.id).toBe('42');
  });

  it('walks a multi-cursor listing to the very end', async () => {
    const ids: string[] = [];
    for await (const item of client.paginate<{ id: string }>('/wiki/api/v2/pages/1/descendants', { limit: 250 })) {
      ids.push(item.id);
    }
    expect(ids).toHaveLength(310);
    expect(ids.at(-1)).toBe('1309');
  });

  it('retries a real 429 honouring Retry-After and then succeeds', async () => {
    const created = await client.request<{ id: string }>('POST', '/wiki/api/v2/pages', {
      body: { spaceId: '42', status: 'current', title: 'Rate limited', parentId: '1' },
    });
    expect(created.id).toBe('900');
  });

  it('surfaces the API message on a 400 without retrying', async () => {
    const error = await client
      .request('POST', '/wiki/api/v2/pages', {
        body: { spaceId: '42', status: 'current', title: 'Bad XHTML', parentId: '1' },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfluenceHttpError);
    expect((error as ConfluenceHttpError).status).toBe(400);
    expect((error as ConfluenceHttpError).body).toContain('storage format');
  });
});
