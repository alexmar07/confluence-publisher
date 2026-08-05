import type { ConfluenceClient } from './confluence/client.js';
import { attachmentHash, attachmentsToUpload, chunkAttachmentHashes } from './confluence/legacyAttachments.js';
import type * as legacy from './confluence/legacyAttachments.js';
import type * as pages from './confluence/pages.js';
import type { PropertyRecord } from './confluence/pages.js';
import { composeBody } from './markdown/storage.js';
import {
  attachmentHashKey, computeContentHash, PROPERTY_KEYS,
  type IndexEntry, type Plan, type PlannedPage,
} from './plan.js';
import { mapPool } from './pool.js';

export type OutcomeKind = 'created' | 'updated' | 'moved' | 'skipped' | 'failed';

export interface Outcome {
  sourcePath: string;
  title: string;
  synthetic: boolean;
  kind: OutcomeKind;
  pageId: string | null;
  error?: { status: number | null; message: string };
}

export interface ExecuteDeps {
  createPage: typeof pages.createPage;
  updatePage: typeof pages.updatePage;
  writeProperty: typeof pages.writeProperty;
  uploadAttachment: typeof legacy.uploadAttachment;
  readFile: (sourcePath: string) => Promise<Uint8Array>;
  log: { info: (m: string) => void; warning: (m: string) => void; debug: (m: string) => void };
}

export interface ExecuteInput {
  plan: Plan;
  spaceId: string;
  versionMessage: string;
  concurrency: number;
  footer: ((sourcePath: string) => string) | null;
  index: ReadonlyMap<string, IndexEntry>;
  /** Properties already read by the index scan, keyed by pageId; absent in tests. */
  knownProperties?: ReadonlyMap<string, Map<string, PropertyRecord>>;
}

export interface ExecuteResult {
  outcomes: Outcome[];
  attachmentsUploaded: number;
}

// A bare `(error as {…}).status` read throws when `error` is itself `null` or `undefined` —
// a legitimate rejection reason (e.g. `Promise.reject(null)`). errorInfo is the error handler:
// a throw here would replace a reportable per-page failure with an unhandled exception that
// aborts the whole run, so the property read is guarded before the cast.
function errorInfo(error: unknown): { status: number | null; message: string } {
  const status =
    typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : null;
  return { status, message: error instanceof Error ? error.message : String(error) };
}

export async function executePlan(
  client: ConfluenceClient,
  input: ExecuteInput,
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const outcomes: Outcome[] = [];
  const resolvedParent = new Map<string, string>();     // parent source-path → real pageId
  const failedParents = new Map<string, string>();      // parent source-path → failure cause
  let attachmentsUploaded = 0;

  const propertiesOf = (pageId: string): Map<string, PropertyRecord> =>
    input.knownProperties?.get(pageId) ?? new Map<string, PropertyRecord>();

  const reconcileAttachments = async (page: PlannedPage, pageId: string): Promise<void> => {
    if (page.attachments.length === 0) return;
    const localHashes = new Map<string, string>();
    const bytes = new Map<string, Uint8Array>();
    let unreadable = false;
    for (const attachment of page.attachments) {
      try {
        const data = await deps.readFile(attachment.sourcePath);
        bytes.set(attachment.filename, data);
        localHashes.set(attachment.filename, attachmentHash(data));
      } catch (error) {
        unreadable = true;
        deps.log.warning(
          `${page.node.sourcePath}: attachment "${attachment.sourcePath}" could not be read and was skipped: ${errorInfo(error).message}`,
        );
      }
    }
    const stored = input.index.get(page.node.sourcePath)?.attachmentHashes ?? {};
    const pending = attachmentsToUpload(localHashes, stored);

    // Only the upload loop is gated on `pending`: it holds local filenames alone, so a
    // *removed* attachment never enters it, and returning early here would skip the property
    // rewrite and stale-chunk cleanup below — exactly the shrink case they exist for.
    // `writeProperty`'s own value-equality gate makes the unchanged case a no-op regardless.
    for (const filename of pending) {
      await deps.uploadAttachment(client, pageId, filename, bytes.get(filename) as Uint8Array);
      attachmentsUploaded += 1;
    }

    // An unreadable file must not erase the hash recorded for it, or the next run would
    // believe the attachment is missing and upload nothing.
    const merged = unreadable ? new Map(Object.entries(stored)) : new Map<string, string>();
    for (const [filename, hash] of localHashes) merged.set(filename, hash);

    const known = propertiesOf(pageId);
    const chunks = chunkAttachmentHashes(merged);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const key = attachmentHashKey(chunkIndex);
      // chunkAttachmentHashes always seeds its result with `[{}]`, so an empty hash map still
      // yields exactly one empty chunk; writing it would POST a needless empty property onto a
      // page that never had one. But when the property already exists under this key, the empty
      // chunk must still be written — that's the shrink-to-zero case that clears it.
      if (Object.keys(chunk).length === 0 && !known.has(key)) continue;
      await deps.writeProperty(client, pageId, key, chunk, known);
    }
    // A shrunken map leaves stale numbered chunks behind; they are emptied, never deleted,
    // because the v2 API offers no property deletion that is safe under concurrency.
    for (const key of known.keys()) {
      const isChunk = key.startsWith(`${PROPERTY_KEYS.attachmentHashes}.`);
      const stillUsed = chunks.some((_, i) => attachmentHashKey(i) === key);
      if (isChunk && !stillUsed) await deps.writeProperty(client, pageId, key, {}, known);
    }
  };

  const publish = async (page: PlannedPage, parentId: string): Promise<Outcome> => {
    // Recomputed against the *real, resolved* parentId, never the plan's precomputed value:
    // buildPlan may have hashed against a null parent when the container did not exist yet,
    // and persisting that value would make the page reclassify as 'update' on every future
    // run once the container exists.
    const hash = computeContentHash(page.node.title, parentId, page.storage);
    const body = composeBody(page.storage, input.footer ? input.footer(page.node.sourcePath) : null);

    if (page.action === 'skip' && page.pageId !== null) {
      await reconcileAttachments(page, page.pageId);
      return { sourcePath: page.node.sourcePath, title: page.node.title, synthetic: page.node.synthetic, kind: 'skipped', pageId: page.pageId };
    }

    let pageId: string;
    let kind: OutcomeKind;
    if (page.pageId === null) {
      const created = await deps.createPage(client, {
        spaceId: input.spaceId, title: page.node.title, parentId, storage: body,
      });
      pageId = created.id;
      kind = 'created';
    } else {
      await deps.updatePage(client, {
        pageId: page.pageId, title: page.node.title, parentId, storage: body, versionMessage: input.versionMessage,
      });
      pageId = page.pageId;
      kind = page.action === 'move' ? 'moved' : 'updated';
    }

    const known = propertiesOf(pageId);
    await deps.writeProperty(client, pageId, PROPERTY_KEYS.sourcePath, page.node.sourcePath, known);
    if (page.node.synthetic) await deps.writeProperty(client, pageId, PROPERTY_KEYS.synthetic, true, known);
    await deps.writeProperty(client, pageId, PROPERTY_KEYS.contentHash, hash, known);
    await reconcileAttachments(page, pageId);

    return { sourcePath: page.node.sourcePath, title: page.node.title, synthetic: page.node.synthetic, kind, pageId };
  };

  /**
   * Containers are resolved sequentially, depth-first, before any leaf is published. A failed
   * container marks its whole subtree as failed instead of emitting 404s.
   */
  const containers = input.plan.pages.filter((page) => page.node.children.length > 0);
  const leaves = input.plan.pages.filter((page) => page.node.children.length === 0);

  for (const container of containers) {
    const parentPath = container.parentSourcePath;
    const cause = parentPath === null ? undefined : failedParents.get(parentPath);
    if (cause !== undefined) {
      failedParents.set(container.node.sourcePath, cause);
      outcomes.push({
        sourcePath: container.node.sourcePath, title: container.node.title, synthetic: container.node.synthetic,
        kind: 'failed', pageId: null, error: { status: null, message: `parent unavailable: ${cause}` },
      });
      continue;
    }

    const parentId = parentPath === null ? null : resolvedParent.get(parentPath) ?? null;
    try {
      const outcome = await publish(container, parentId ?? (container.expectedParentId ?? ''));
      resolvedParent.set(container.node.sourcePath, outcome.pageId as string);
      outcomes.push(outcome);
      deps.log.info(`${outcome.kind}: ${outcome.sourcePath}`);
    } catch (error) {
      const info = errorInfo(error);
      failedParents.set(container.node.sourcePath, info.message);
      outcomes.push({
        sourcePath: container.node.sourcePath, title: container.node.title, synthetic: container.node.synthetic,
        kind: 'failed', pageId: null, error: info,
      });
      deps.log.warning(`failed: ${container.node.sourcePath}: ${info.message}`);
    }
  }

  const leafOutcomes = await mapPool(leaves, input.concurrency, async (leaf): Promise<Outcome> => {
    const parentPath = leaf.parentSourcePath;
    const cause = parentPath === null ? undefined : failedParents.get(parentPath);
    if (cause !== undefined) {
      return {
        sourcePath: leaf.node.sourcePath, title: leaf.node.title, synthetic: leaf.node.synthetic,
        kind: 'failed', pageId: null, error: { status: null, message: `parent unavailable: ${cause}` },
      };
    }
    const parentId = parentPath === null ? leaf.expectedParentId : resolvedParent.get(parentPath) ?? leaf.expectedParentId;
    try {
      const outcome = await publish(leaf, parentId ?? '');
      deps.log.info(`${outcome.kind}: ${outcome.sourcePath}`);
      return outcome;
    } catch (error) {
      const info = errorInfo(error);
      deps.log.warning(`failed: ${leaf.node.sourcePath}: ${info.message}`);
      return {
        sourcePath: leaf.node.sourcePath, title: leaf.node.title, synthetic: leaf.node.synthetic,
        kind: 'failed', pageId: null, error: info,
      };
    }
  });

  outcomes.push(...leafOutcomes);
  return { outcomes, attachmentsUploaded };
}
