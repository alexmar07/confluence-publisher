import { createHash } from 'node:crypto';
import type { ConfluenceClient } from './client.js';

/**
 * WARNING: the single documented exception to the v2-only API rule. Confluence Cloud REST API
 * v2 does not expose any attachment upload endpoint: reading attachments is available at
 * /wiki/api/v2/pages/{id}/attachments, but creating or updating one is only possible through
 * the deprecated v1 endpoints used below.
 *
 * When Atlassian ships v2 upload endpoints, replace `uploadAttachment` with the v2 calls
 * and delete this notice; nothing else in the codebase touches /wiki/rest/api.
 */

export interface ExistingAttachment {
  id: string;
  title: string;
}

/** Content properties have a size limit, so the digest is stored base64url, not hex. */
export function attachmentHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('base64url');
}

export function attachmentsToUpload(
  local: ReadonlyMap<string, string>,
  stored: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const [filename, hash] of local) {
    if (stored[filename] !== hash) out.push(filename);
  }
  return out;
}

export const PROPERTY_VALUE_LIMIT_BYTES = 30_000;

/**
 * A page with hundreds of attachments would overflow the content property size limit, so the
 * map is split across the numbered keys produced by `attachmentHashKey`. An empty map still
 * yields one empty chunk, so that a previously stored value is overwritten.
 *
 * Contract: each chunk's JSON serialisation respects `limitBytes`, except when a single entry
 * alone exceeds it — that entry gets its own over-limit chunk rather than being silently
 * dropped (which would lose state) or causing an infinite loop (splitting a single key is not
 * possible). Under the default 30,000-byte limit this needs a ~29,950-character filename, which
 * no real filesystem produces (paths are capped at 255 bytes per component), so the degenerate
 * case is accepted rather than guarded against.
 *
 * Entries are processed in filename-sorted (plain lexicographic, not locale-aware) order rather
 * than the input map's iteration order. `writeProperty` (src/confluence/pages.ts) decides
 * whether to skip a property PUT by comparing `JSON.stringify` of the old and new values, which
 * is key-order sensitive; sorting here makes the emitted key order depend only on the attachment
 * set, not on whatever order the caller's map happens to iterate in, so hash-gating isn't
 * defeated by a redundant PUT every run.
 */
export function chunkAttachmentHashes(
  hashes: ReadonlyMap<string, string>,
  limitBytes: number = PROPERTY_VALUE_LIMIT_BYTES,
): Record<string, string>[] {
  const sorted = [...hashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks: Record<string, string>[] = [{}];
  for (const [filename, hash] of sorted) {
    const current = chunks[chunks.length - 1] as Record<string, string>;
    const candidate = { ...current, [filename]: hash };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > limitBytes && Object.keys(current).length > 0) {
      chunks.push({ [filename]: hash });
      continue;
    }
    current[filename] = hash;
  }
  return chunks;
}

export async function listAttachments(
  client: ConfluenceClient,
  pageId: string,
): Promise<ExistingAttachment[]> {
  const out: ExistingAttachment[] = [];
  for await (const raw of client.paginate<{ id: string; title: string }>(
    `/wiki/api/v2/pages/${pageId}/attachments`,
    { limit: 250 },
  )) {
    out.push({ id: String(raw.id), title: raw.title });
  }
  return out;
}

export async function uploadAttachment(
  client: ConfluenceClient,
  pageId: string,
  filename: string,
  data: Uint8Array,
): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([data]), filename);
  form.append('minorEdit', 'true');

  // The create-only endpoint rejects a filename that already exists on the page (HTTP 400,
  // "Cannot add a new attachment with same file name as an existing attachment"), which is
  // exactly the byte-wise-replace case this must support. So: look the filename up first, and
  // route to the update endpoint when it is already there.
  //
  // This lookup runs once per *uploaded* attachment rather than once per *page* — a
  // deliberate trade-off, not an oversight. `attachmentsToUpload` (above) already hash-gates
  // the candidate list against the stored digests before `uploadAttachment` is ever called,
  // so in practice this only runs for files whose content genuinely changed, which on any
  // given run is a small subset of a page's attachments (often zero, rarely more than one or
  // two). Hoisting the listing to once-per-page would save a handful of GETs in the rare case
  // of many changed attachments on the same page, at the cost of a second code path and a
  // staleness window against concurrent uploads; do not "optimise" it back in.
  const existing = await listAttachments(client, pageId);
  const hit = existing.find((attachment) => attachment.title === filename);

  await client.request(
    'POST',
    hit
      ? `/wiki/rest/api/content/${pageId}/child/attachment/${hit.id}/data`
      : `/wiki/rest/api/content/${pageId}/child/attachment`,
    { rawBody: form, headers: { 'x-atlassian-token': 'no-check' } },
  );
}
