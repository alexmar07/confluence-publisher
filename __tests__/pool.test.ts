import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/pool.js';

describe('mapPool', () => {
  it('preserves result order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1];
    const result = await mapPool(delays, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('never runs more than `limit` jobs at once', async () => {
    let running = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4, 5, 6], 2, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return null;
    });
    expect(peak).toBe(2);
  });

  // `limit` must stay below the item count, and the rejection must land on an early item: with
  // limit >= items every job is started before the first one can fail, so "runs every job" would
  // hold by construction rather than by anything the pool does. Here items 2..5 are still queued
  // when item 1 rejects, so they only run if the worker keeps pulling after a failure.
  it('keeps pulling queued jobs after one rejects, then throws the first error', async () => {
    const seen: number[] = [];
    await expect(
      mapPool([0, 1, 2, 3, 4, 5], 2, async (n) => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(n);
        if (n === 1) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('throws the first error, not the last one', async () => {
    await expect(
      mapPool([0, 1, 2, 3], 1, async (n) => {
        await new Promise((r) => setTimeout(r, 1));
        if (n === 1) throw new Error('first');
        if (n === 2) throw new Error('second');
        return n;
      }),
    ).rejects.toThrow('first');
  });

  // `undefined` was both the "no error yet" sentinel and a legitimate rejection reason.
  // A job doing `Promise.reject(undefined)` (or `throw undefined`) got recorded into
  // `firstError`, then silently discarded at `if (firstError !== undefined) throw firstError`,
  // so mapPool resolved as if nothing had failed. It must reject instead.
  it('rejects rather than resolving when a job rejects with undefined', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a non-Error reason; that is exactly the case this test guards against
    await expect(mapPool([0, 1], 1, () => Promise.reject(undefined))).rejects.toBeUndefined();
  });

  it('rejects rather than resolving when a job rejects with null', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a non-Error reason; that is exactly the case the previous test guards against
    await expect(mapPool([0, 1], 1, () => Promise.reject(null))).rejects.toBeNull();
  });
});
