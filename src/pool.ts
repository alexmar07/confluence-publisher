// `undefined` is both the "no error yet" sentinel and a legitimate rejection reason
// (`Promise.reject(undefined)` / `throw undefined`), so `firstError`'s own value cannot tell
// the two apart. `NO_ERROR` is a module-private symbol no rejection reason could ever equal;
// since it never escapes `mapPool`, one symbol at module scope safely serves every call.
const NO_ERROR: unique symbol = Symbol('mapPool: no error');

/** Runs `fn` over `items` with at most `limit` concurrent jobs, preserving input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let firstError: unknown = NO_ERROR;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        if (firstError === NO_ERROR) firstError = error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  // Rethrows the original rejection reason, which may legitimately be a non-Error value; that is
  // deliberate, not something to coerce away.
  if (firstError !== NO_ERROR) throw firstError;
  return results;
}
