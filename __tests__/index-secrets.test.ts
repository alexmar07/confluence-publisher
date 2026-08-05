import { beforeEach, describe, expect, it, vi } from 'vitest';

// `core.setSecret()` must run before any other operation, so that not even a validation
// error thrown while parsing the config can echo a credential — or log anything at all —
// ahead of the credentials being masked in the runner's log renderer. `base-url` is
// deliberately invalid so `parseConfig` throws before constructing a `ConfluenceClient`,
// before any network call, and before any other `core.*` call production code could reach.
const rawInputs: Record<string, string> = {
  folder: 'docs',
  'base-url': 'not-a-url',
  username: 'alice@example.com',
  'api-token': 'super-secret-token',
  'space-key': 'DOC',
  'parent-page-id': '123',
};

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => rawInputs[name] ?? ''),
  setSecret: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  summary: { addRaw: vi.fn(() => ({ write: vi.fn(() => Promise.resolve()) })) },
}));

import * as core from '@actions/core';
import { run } from '../src/index.js';

describe('setSecret ordering (R10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers both credentials as secrets before parseConfig can fail', async () => {
    await expect(run()).rejects.toThrow(/base-url/);

    const registered = vi.mocked(core.setSecret).mock.calls.map((call) => call[0]);
    expect(registered).toContain('super-secret-token');
    expect(registered).toContain('alice@example.com');
  });

  it('calls setSecret before any core.debug/core.info/core.warning call — ordering, not just occurrence', async () => {
    await expect(run()).rejects.toThrow(/base-url/);

    const setSecretOrder = vi.mocked(core.setSecret).mock.invocationCallOrder;
    expect(setSecretOrder.length).toBeGreaterThan(0);
    const firstSetSecret = setSecretOrder[0] as number;

    for (const sink of [core.debug, core.info, core.warning] as const) {
      for (const order of vi.mocked(sink).mock.invocationCallOrder) {
        expect(order).toBeGreaterThan(firstSetSecret);
      }
    }
  });
});
