import { mapPool } from '../pool.js';
import { PROPERTY_KEYS, type IndexEntry } from '../plan.js';
import { ConfluenceClient, ConfluenceHttpError } from './client.js';

export interface PageSummary {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  spaceId: string | null;
}

export interface PropertyRecord {
  propertyId: string;
  version: number;
  value: unknown;
}

export type PageStatus = 'current' | 'archived' | 'trashed';

interface RawPage {
  id: string;
  title?: string;
  status?: string;
  parentId?: string | null;
  spaceId?: string | null;
  type?: string;
}

function toSummary(raw: RawPage): PageSummary {
  return {
    id: String(raw.id),
    title: raw.title ?? '',
    status: raw.status ?? 'current',
    parentId: raw.parentId === undefined || raw.parentId === null ? null : String(raw.parentId),
    spaceId: raw.spaceId === undefined || raw.spaceId === null ? null : String(raw.spaceId),
  };
}

async function nullOn404<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ConfluenceHttpError && error.status === 404) return null;
    throw error;
  }
}

export async function resolveSpaceId(
  client: ConfluenceClient,
  spaceKey: string,
): Promise<string | null> {
  const response = await client.request<{ results?: { id: string; key: string }[] }>(
    'GET',
    '/wiki/api/v2/spaces',
    { query: { keys: spaceKey } },
  );
  const match = (response.results ?? []).find((space) => space.key === spaceKey) ?? response.results?.[0];
  return match ? String(match.id) : null;
}

export async function getPage(client: ConfluenceClient, pageId: string): Promise<PageSummary | null> {
  const raw = await nullOn404(client.request<RawPage>('GET', `/wiki/api/v2/pages/${pageId}`));
  return raw === null ? null : toSummary(raw);
}

export async function isFolder(client: ConfluenceClient, contentId: string): Promise<boolean> {
  const raw = await nullOn404(client.request<RawPage>('GET', `/wiki/api/v2/folders/${contentId}`));
  return raw !== null;
}

export async function findPagesByTitle(
  client: ConfluenceClient,
  spaceId: string,
  title: string,
  statuses: readonly PageStatus[],
): Promise<PageSummary[]> {
  const out: PageSummary[] = [];
  for await (const raw of client.paginate<RawPage>('/wiki/api/v2/pages', {
    'space-id': spaceId,
    title,
    status: statuses.join(','),
    limit: 250,
  })) {
    out.push(toSummary(raw));
  }
  return out;
}

/**
 * The API caps `depth` at 10 (`depth=100` is rejected with "greater than the max allowed: 10").
 * Deeper trees are walked in successive slices, restarting from the pages that sit at the
 * deepest level of each slice.
 */
export const MAX_DESCENDANT_DEPTH = 10;

interface DescendantSliceItem {
  page: PageSummary;
  depth: number;
  /** The `depth` field as returned by the API, undefined when the response omits it entirely. */
  rawDepth: number | undefined;
}

async function listDescendantSlice(
  client: ConfluenceClient,
  parentPageId: string,
  depth: number,
): Promise<DescendantSliceItem[]> {
  const out: DescendantSliceItem[] = [];
  for await (const raw of client.paginate<RawPage & { depth?: number }>(
    `/wiki/api/v2/pages/${parentPageId}/descendants`,
    { depth, limit: 250 },
  )) {
    if ((raw.type ?? 'page') !== 'page') continue;
    out.push({ page: toSummary(raw), depth: raw.depth ?? 1, rawDepth: raw.depth });
  }
  return out;
}

export async function listDescendants(
  client: ConfluenceClient,
  parentPageId: string,
  depth: number,
): Promise<PageSummary[]> {
  const collected = new Map<string, PageSummary>();

  const walk = async (rootId: string, remaining: number): Promise<void> => {
    const slice = Math.min(remaining, MAX_DESCENDANT_DEPTH);
    const found = await listDescendantSlice(client, rootId, slice);
    for (const { page } of found) collected.set(page.id, page);
    if (remaining <= MAX_DESCENDANT_DEPTH) return;

    // A deeper walk relies on the API annotating each item with its depth relative to the
    // queried root. If the response never carries that field, silently continuing would
    // truncate the tree without any signal: pages beyond MAX_DESCENDANT_DEPTH would simply
    // vanish from the index. Fail loudly instead.
    if (found.length > 0 && found.every((item) => item.rawDepth === undefined)) {
      throw new Error(
        'The descendants response carries no per-item depth; '
        + `the tree cannot be walked safely beyond depth ${MAX_DESCENDANT_DEPTH}`,
      );
    }

    // Only the deepest level of this slice can hide further descendants.
    for (const { page, depth: reached } of found) {
      if (reached >= slice) await walk(page.id, remaining - slice);
    }
  };

  await walk(parentPageId, Math.max(1, depth));
  return [...collected.values()];
}

export async function readProperties(
  client: ConfluenceClient,
  pageId: string,
): Promise<Map<string, PropertyRecord>> {
  const out = new Map<string, PropertyRecord>();
  for await (const raw of client.paginate<{
    id: string;
    key: string;
    value: unknown;
    version?: { number?: number };
  }>(`/wiki/api/v2/pages/${pageId}/properties`, { limit: 100 })) {
    out.set(raw.key, {
      propertyId: String(raw.id),
      version: raw.version?.number ?? 1,
      value: raw.value,
    });
  }
  return out;
}

/**
 * Content properties are not CQL-searchable without an app descriptor, so the index is built
 * by walking the descendant tree and reading each page's properties.
 *
 * @param onArchivedConflict Called for each non-current page that still carries a `source-path`
 *   property (e.g. an archived page whose source was later republished elsewhere).
 * @param onDuplicateSourcePath Called when two `current` pages carry the same `source-path`
 *   value (e.g. a page duplicated in the Confluence UI, which copies its content properties
 *   along with it). The later-processed page wins the `bySourcePath` slot; the one it displaces
 *   is routed to `unmanaged` so `buildPlan`'s leftover detection still surfaces it, rather than
 *   letting it vanish silently.
 */
export async function buildIndex(
  client: ConfluenceClient,
  parentPageId: string,
  depth: number,
  concurrency: number,
  onArchivedConflict?: (page: PageSummary) => void,
  onDuplicateSourcePath?: (page: PageSummary, previous: IndexEntry) => void,
): Promise<{
  bySourcePath: Map<string, IndexEntry>;
  unmanaged: IndexEntry[];
  propertiesByPageId: Map<string, Map<string, PropertyRecord>>;
}> {
  const descendants = await listDescendants(client, parentPageId, depth);
  const records = await mapPool(descendants, concurrency, async (page) => ({
    page,
    properties: await readProperties(client, page.id),
  }));

  const bySourcePath = new Map<string, IndexEntry>();
  const unmanaged: IndexEntry[] = [];
  const propertiesByPageId = new Map<string, Map<string, PropertyRecord>>();

  for (const { page, properties } of records) {
    propertiesByPageId.set(page.id, properties);
    const sourceProperty = properties.get(PROPERTY_KEYS.sourcePath);
    const sourcePath = typeof sourceProperty?.value === 'string' ? sourceProperty.value : null;
    const hashValue = properties.get(PROPERTY_KEYS.contentHash)?.value;

    // The attachment map may be spread over numbered keys, so every chunk is merged back.
    const attachmentHashes: Record<string, string> = {};
    for (const [key, record] of properties) {
      if (key !== PROPERTY_KEYS.attachmentHashes && !key.startsWith(`${PROPERTY_KEYS.attachmentHashes}.`)) continue;
      if (record.value !== null && typeof record.value === 'object') {
        Object.assign(attachmentHashes, record.value as Record<string, string>);
      }
    }

    const entry: IndexEntry = {
      pageId: page.id,
      title: page.title,
      parentId: page.parentId,
      sourcePath,
      synthetic: properties.get(PROPERTY_KEYS.synthetic)?.value === true,
      contentHash: typeof hashValue === 'string' ? hashValue : null,
      attachmentHashes,
    };

    if (page.status !== 'current') {
      if (sourcePath !== null) onArchivedConflict?.(page);
      continue;
    }
    if (sourcePath === null) {
      unmanaged.push(entry);
    } else {
      const previous = bySourcePath.get(sourcePath);
      if (previous !== undefined) {
        unmanaged.push(previous);
        onDuplicateSourcePath?.(page, previous);
      }
      bySourcePath.set(sourcePath, entry);
    }
  }

  return { bySourcePath, unmanaged, propertiesByPageId };
}

export interface CreatePageInput {
  spaceId: string;
  title: string;
  parentId: string;
  storage: string;
}

export interface UpdatePageInput {
  pageId: string;
  title: string;
  parentId: string;
  storage: string;
  versionMessage: string;
}

export async function createPage(
  client: ConfluenceClient,
  input: CreatePageInput,
): Promise<PageSummary> {
  const raw = await client.request<RawPage>('POST', '/wiki/api/v2/pages', {
    body: {
      spaceId: input.spaceId,
      status: 'current',
      title: input.title,
      parentId: input.parentId,
      body: { representation: 'storage', value: input.storage },
    },
  });
  return toSummary(raw);
}

/** The version number must be current + 1; a stale value yields 409, retried once. */
// PUT /pages/{id} also moves the page when parentId changes.
export async function updatePage(
  client: ConfluenceClient,
  input: UpdatePageInput,
): Promise<PageSummary> {
  const attempt = async (): Promise<PageSummary> => {
    const current = await client.request<RawPage & { version?: { number?: number } }>(
      'GET',
      `/wiki/api/v2/pages/${input.pageId}`,
    );
    const next = (current.version?.number ?? 1) + 1;
    const raw = await client.request<RawPage>('PUT', `/wiki/api/v2/pages/${input.pageId}`, {
      body: {
        id: input.pageId,
        status: 'current',
        title: input.title,
        parentId: input.parentId,
        body: { representation: 'storage', value: input.storage },
        version: { number: next, message: input.versionMessage },
      },
    });
    return toSummary(raw);
  };

  try {
    return await attempt();
  } catch (error) {
    if (error instanceof ConfluenceHttpError && error.status === 409) return await attempt();
    throw error;
  }
}

export async function writeProperty(
  client: ConfluenceClient,
  pageId: string,
  key: string,
  value: unknown,
  known?: Map<string, PropertyRecord>,
): Promise<void> {
  // `known` being supplied at all means the page's properties have already been read in
  // full (index scan, or a fresh empty map for a page just created): a key missing from
  // it is genuinely absent, not merely unknown. Only the *absence* of the map itself
  // ("no read happened yet") should trigger a live paginated read here.
  const existing = known !== undefined ? known.get(key) : (await readProperties(client, pageId)).get(key);
  if (existing === undefined) {
    await client.request('POST', `/wiki/api/v2/pages/${pageId}/properties`, { body: { key, value } });
    return;
  }
  if (JSON.stringify(existing.value) === JSON.stringify(value)) return;

  const put = async (record: PropertyRecord): Promise<void> => {
    await client.request('PUT', `/wiki/api/v2/pages/${pageId}/properties/${record.propertyId}`, {
      body: { key, value, version: { number: record.version + 1 } },
    });
  };

  try {
    await put(existing);
  } catch (error) {
    // Mirrors `updatePage`: `known` was captured once, by the index scan at the start of the
    // run, so a concurrent run that has since bumped this property makes the version stale
    // and the PUT 409. Re-read the property and retry exactly once; a second 409 propagates.
    if (!(error instanceof ConfluenceHttpError && error.status === 409)) throw error;
    const fresh = (await readProperties(client, pageId)).get(key);
    if (fresh === undefined) throw error;
    await put(fresh);
  }
}
