import { createHash } from 'node:crypto';
import type { AttachmentRef } from './markdown/storage.js';
import type { PageNode } from './tree.js';

export const PROPERTY_KEYS = {
  sourcePath: 'confluence-docs-publisher.source-path',
  synthetic: 'confluence-docs-publisher.synthetic',
  contentHash: 'confluence-docs-publisher.content-hash',
  attachmentHashes: 'confluence-docs-publisher.attachment-hashes',
} as const;

/** Chunk 0 keeps the base key, further chunks get a numbered suffix. */
export function attachmentHashKey(chunkIndex: number): string {
  return chunkIndex === 0
    ? PROPERTY_KEYS.attachmentHashes
    : `${PROPERTY_KEYS.attachmentHashes}.${chunkIndex + 1}`;
}

/** A page already present on Confluence, as detected by the index scan. */
export interface IndexEntry {
  pageId: string;
  title: string;
  parentId: string | null;
  sourcePath: string | null;
  synthetic: boolean;
  contentHash: string | null;
  attachmentHashes: Readonly<Record<string, string>>;
}

export type PlannedAction = 'create' | 'update' | 'move' | 'skip';

export interface PlannedPage {
  node: PageNode;
  action: PlannedAction;
  pageId: string | null;
  storage: string;
  parentSourcePath: string | null;
  expectedParentId: string | null;
  contentHash: string;
  attachments: AttachmentRef[];
}

export type LeftoverCategory = 'excluded' | 'orphan' | 'unmanaged';

export interface LeftoverPage {
  entry: IndexEntry;
  category: LeftoverCategory;
}

export interface PlanInput {
  roots: readonly PageNode[];
  storageBySourcePath: ReadonlyMap<string, { xhtml: string; attachments: AttachmentRef[] }>;
  index: ReadonlyMap<string, IndexEntry>;
  unmanagedEntries: readonly IndexEntry[];
  rootParentId: string;
  sourceExists: (sourcePath: string) => boolean;
}

export interface Plan {
  pages: PlannedPage[];
  leftovers: LeftoverPage[];
}

/**
 * The parent id takes part in the hash so a file moved to another folder, with unchanged
 * content, does not produce a matching hash and stay attached to its old parent. The footer
 * is never part of `storageXhtml`.
 *
 * The three fields are combined via `JSON.stringify` rather than delimiter concatenation: a
 * naive `${title}\n${parentId}\n${xhtml}` join is ambiguous whenever a field itself contains
 * a newline (a CommonMark Setext heading like "Line one\nLine two\n======" yields a title
 * containing a literal "\n"), so two different triples could serialise to the same string.
 * JSON.stringify escapes embedded newlines and quotes each element, avoiding that collision.
 */
export function computeContentHash(
  title: string,
  parentId: string | null,
  storageXhtml: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([title, parentId, storageXhtml]), 'utf8')
    .digest('hex');
}

export function buildPlan(input: PlanInput): Plan {
  const pages: PlannedPage[] = [];
  const published = new Set<string>();

  const visit = (node: PageNode, parentPageId: string | null, parentSourcePath: string | null): void => {
    published.add(node.sourcePath);
    const existing = input.index.get(node.sourcePath) ?? null;
    const rendered = input.storageBySourcePath.get(node.sourcePath) ?? { xhtml: '', attachments: [] };
    const expectedParentId = parentPageId;
    const contentHash = computeContentHash(node.title, expectedParentId, rendered.xhtml);

    let action: PlannedAction;
    if (existing === null) {
      action = 'create';
    } else if (expectedParentId === null || existing.parentId !== expectedParentId) {
      action = 'move';
    } else if (existing.contentHash !== null && existing.contentHash === contentHash) {
      action = 'skip';
    } else {
      action = 'update';
    }

    pages.push({
      node,
      action,
      pageId: existing?.pageId ?? null,
      storage: rendered.xhtml,
      parentSourcePath,
      expectedParentId,
      contentHash,
      attachments: rendered.attachments,
    });

    for (const child of node.children) visit(child, existing?.pageId ?? null, node.sourcePath);
  };

  for (const root of input.roots) visit(root, input.rootParentId, null);

  const leftovers: LeftoverPage[] = [];
  for (const entry of input.index.values()) {
    if (entry.sourcePath === null || published.has(entry.sourcePath)) continue;
    leftovers.push({
      entry,
      category: input.sourceExists(entry.sourcePath) ? 'excluded' : 'orphan',
    });
  }
  for (const entry of input.unmanagedEntries) {
    leftovers.push({ entry, category: 'unmanaged' });
  }

  return { pages, leftovers };
}
