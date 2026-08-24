import { ConfluenceClient, ConfluenceHttpError } from './confluence/client.js';
import {
  findPagesByTitle, getPage, isFolder, readProperties, resolveSpaceId, type PageSummary,
} from './confluence/pages.js';
import { computeContentHash, PROPERTY_KEYS, type IndexEntry } from './plan.js';
import { mapPool } from './pool.js';
import type { PageNode } from './tree.js';

export class PreflightError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export interface EnvironmentPreflightResult {
  spaceId: string;
  parentTitle: string;
}

export async function preflightEnvironment(
  client: ConfluenceClient,
  spaceKey: string,
  parentPageId: string,
): Promise<EnvironmentPreflightResult> {
  let spaceId: string | null;
  try {
    spaceId = await resolveSpaceId(client, spaceKey);
  } catch (error) {
    if (error instanceof ConfluenceHttpError && (error.status === 401 || error.status === 403)) {
      throw new PreflightError(
        `Space "${spaceKey}" could not be read: the credentials are valid for the site but lack permission on that space (HTTP ${error.status}).`,
      );
    }
    throw error;
  }
  if (spaceId === null) {
    throw new PreflightError(
      `Space "${spaceKey}" does not exist, or the account has no permission to see it. Check the space key in the Confluence URL.`,
    );
  }

  const page = await getPage(client, parentPageId);
  if (page === null) {
    if (await isFolder(client, parentPageId)) {
      throw new PreflightError(
        `parent-page-id "${parentPageId}" is a Folder, not a Page. Confluence cannot host pages under a Folder through this API: pick the id of a Page.`,
      );
    }
    throw new PreflightError(
      `parent-page-id "${parentPageId}" is neither a Page nor a Folder. The remaining causes are: the page is deleted or in the trash, or it lives in a different space than "${spaceKey}".`,
    );
  }
  // `GET /pages/{id}` resolves archived and trashed pages just as happily as current ones, so a
  // parent that exists is not yet a parent that can hold children: `POST /pages` answers a
  // non-current `parentId` with a bare 404 "Cannot find content with id", once per source file,
  // long after the preflight has declared the environment sound.
  if (page.status !== 'current') {
    throw new PreflightError(
      `parent-page-id "${parentPageId}" ("${page.title}") has status "${page.status}", not "current". Confluence refuses to create children under it. Restore the page from the space's archive or trash, or pick a current page.`,
    );
  }
  if (page.spaceId !== null && page.spaceId !== spaceId) {
    throw new PreflightError(
      `parent-page-id "${parentPageId}" belongs to space id ${page.spaceId}, while space-key "${spaceKey}" resolves to ${spaceId}. Publishing would build the tree in the wrong space and check title uniqueness against it.`,
    );
  }

  return { spaceId, parentTitle: page.title };
}

export interface TitleConflict {
  title: string;
  sources: string[];
  occupantPageId: string | null;
  occupantStatus: string | null;
  occupantSourcePath: string | null;
  reason:
    | 'internal-duplicate'
    | 'foreign-source-path'
    | 'non-current-status'
    | 'ambiguous-match'
    | 'untracked-occupant';
}

export interface Adoption {
  sourcePath: string;
  page: PageSummary;
}

export interface TitlePreflightResult {
  conflicts: TitleConflict[];
  adoptions: Adoption[];
}

/**
 * Runs after the index has been built: deciding whether a same-titled page belongs to this
 * action requires the source-path → pageId map. That same lookup also answers the migration
 * question, so adoption candidates are returned rather than discarded — buildPlan only
 * consults the index, and would otherwise plan a create that Confluence rejects because the
 * title is already taken.
 */
export async function preflightTitles(
  client: ConfluenceClient,
  spaceId: string,
  nodes: readonly PageNode[],
  index: ReadonlyMap<string, IndexEntry>,
  concurrency: number,
): Promise<TitlePreflightResult> {
  const conflicts: TitleConflict[] = [];
  const adoptions: Adoption[] = [];

  const byTitle = new Map<string, string[]>();
  for (const node of nodes) {
    const bucket = byTitle.get(node.title);
    if (bucket) bucket.push(node.sourcePath);
    else byTitle.set(node.title, [node.sourcePath]);
  }

  const unique: { title: string; sourcePath: string }[] = [];
  for (const [title, sources] of byTitle) {
    if (sources.length > 1) {
      conflicts.push({
        title,
        sources: [...sources],
        occupantPageId: null,
        occupantStatus: null,
        occupantSourcePath: null,
        reason: 'internal-duplicate',
      });
      continue;
    }
    unique.push({ title, sourcePath: sources[0] as string });
  }

  type Verdict = { conflict: TitleConflict } | { adoption: Adoption } | null;

  const remote = await mapPool(unique, concurrency, async ({ title, sourcePath }): Promise<Verdict> => {
    const matches = await findPagesByTitle(client, spaceId, title, ['current', 'archived', 'trashed']);
    const exact = matches.filter((page) => page.title === title);
    if (exact.length === 0) return null;

    const known = index.get(sourcePath);
    if (exact.length === 1 && known !== undefined && exact[0]!.id === known.pageId) return null;

    if (exact.length > 1) {
      return {
        conflict: {
          title,
          sources: [sourcePath],
          occupantPageId: null,
          occupantStatus: null,
          occupantSourcePath: null,
          reason: 'ambiguous-match',
        },
      };
    }

    const occupant = exact[0] as (typeof exact)[number];
    if (occupant.status !== 'current') {
      return {
        conflict: {
          title,
          sources: [sourcePath],
          occupantPageId: occupant.id,
          occupantStatus: occupant.status,
          occupantSourcePath: null,
          reason: 'non-current-status',
        },
      };
    }

    const properties = await readProperties(client, occupant.id);
    const occupantSource = properties.get(PROPERTY_KEYS.sourcePath)?.value;

    if (typeof occupantSource !== 'string') {
      // The page carries no tracking property. It is adoptable only when this source has
      // no page of its own yet; otherwise two distinct pages would claim the same title.
      if (known === undefined) return { adoption: { sourcePath, page: occupant } };
      return {
        conflict: {
          title,
          sources: [sourcePath],
          occupantPageId: occupant.id,
          occupantStatus: occupant.status,
          occupantSourcePath: null,
          reason: 'untracked-occupant',
        },
      };
    }

    if (occupantSource === sourcePath) return null; // already ours

    return {
      conflict: {
        title,
        sources: [sourcePath],
        occupantPageId: occupant.id,
        occupantStatus: occupant.status,
        occupantSourcePath: occupantSource,
        reason: 'foreign-source-path',
      },
    };
  });

  for (const verdict of remote) {
    if (verdict === null) continue;
    if ('conflict' in verdict) conflicts.push(verdict.conflict);
    else adoptions.push(verdict.adoption);
  }
  return { conflicts, adoptions };
}

/**
 * An adopted page enters the index under its source path with no content hash, so that
 * buildPlan produces an update (or a move) and execution writes the tracking properties. It
 * must also leave the unmanaged list, or the leftover scan would report it as unmanaged in
 * the very run that adopts it.
 */
export function applyAdoptions(
  adoptions: readonly Adoption[],
  bySourcePath: Map<string, IndexEntry>,
  unmanaged: IndexEntry[],
): IndexEntry[] {
  const adoptedPageIds = new Set<string>();
  for (const { sourcePath, page } of adoptions) {
    adoptedPageIds.add(page.id);
    bySourcePath.set(sourcePath, {
      pageId: page.id,
      title: page.title,
      parentId: page.parentId,
      sourcePath,
      synthetic: false,
      contentHash: null,
      attachmentHashes: {},
    });
  }
  return unmanaged.filter((entry) => !adoptedPageIds.has(entry.pageId));
}

/** A vanished index entry paired with the fresh source path it is provably the same page as. */
export interface DetectedMove {
  readonly vanished: IndexEntry;
  readonly freshSourcePath: string;
}

/**
 * The title preflight's `foreign-source-path` conflict fires whenever a moved file's title
 * collides with its own now-stale page, because `source-path` alone cannot recognise a
 * relocation. This pairs the two kinds of evidence a genuine move leaves behind, before the
 * title preflight runs, so `applyMoves` can graft the match away and the preflight sees no
 * foreign occupant at all.
 *
 * A "vanished" entry is a previously tracked, non-synthetic page whose source file is gone
 * from disk. A "fresh" node is a tree node with no index entry of its own. The two are the
 * same page, moved, iff both hold:
 *
 *  1. the titles match exactly (case-sensitive), and
 *  2. the fresh node's rendered body, hashed as if it still lived under the vanished entry's
 *     *old* parent, reproduces the vanished entry's stored content-hash exactly.
 *
 * Condition 2 recomputes the hash against `vanished.parentId` rather than comparing hashes
 * directly, because `computeContentHash` folds `parentId` into the digest (see plan.ts): a
 * relocated file never hashes equal to its former self, so recomputing under the old parent
 * isolates location — the one thing a move changes — from title and body, which it does not.
 *
 * Condition 1 is mostly implied by condition 2 (the stored hash was computed from the same
 * title), but guards against a page renamed out-of-band in the Confluence UI, where the
 * index title has drifted from the title the hash was computed against; there condition 2
 * alone could still match a different page.
 *
 * A vanished entry with no stored hash (`contentHash === null`) never matches. Ambiguity — a
 * vanished entry or fresh node matched more than once — is fatal to that match only: the
 * entangled entries fall back to today's behaviour, ordinarily a `foreign-source-path`
 * conflict, rather than guessing which pairing was intended.
 *
 * Synthetic container pages are excluded on both sides: a renamed folder changes the
 * synthetic container's title too, so condition 1 could never hold for it anyway.
 */
export function detectMoves(
  nodes: readonly PageNode[],
  index: ReadonlyMap<string, IndexEntry>,
  storageBySourcePath: ReadonlyMap<string, { xhtml: string }>,
  sourceExists: (sourcePath: string) => boolean,
): DetectedMove[] {
  const vanished = [...index.values()].filter(
    (entry) => !entry.synthetic && entry.sourcePath !== null && !sourceExists(entry.sourcePath),
  );
  const fresh = nodes.filter((node) => !node.synthetic && index.get(node.sourcePath) === undefined);

  const candidatesByVanished = new Map<IndexEntry, string[]>();
  const candidatesByFresh = new Map<string, IndexEntry[]>();

  for (const x of vanished) {
    if (x.contentHash === null) continue; // nothing to prove condition 2 against
    for (const y of fresh) {
      if (y.title !== x.title) continue;
      const rendered = storageBySourcePath.get(y.sourcePath);
      if (rendered === undefined) continue;
      const relocatedHash = computeContentHash(y.title, x.parentId, rendered.xhtml);
      if (relocatedHash !== x.contentHash) continue;

      const forX = candidatesByVanished.get(x) ?? [];
      forX.push(y.sourcePath);
      candidatesByVanished.set(x, forX);

      const forY = candidatesByFresh.get(y.sourcePath) ?? [];
      forY.push(x);
      candidatesByFresh.set(y.sourcePath, forY);
    }
  }

  const moves: DetectedMove[] = [];
  for (const [x, freshMatches] of candidatesByVanished) {
    if (freshMatches.length !== 1) continue; // X matches more than one fresh node: ambiguous
    const freshSourcePath = freshMatches[0] as string;
    const vanishedMatches = candidatesByFresh.get(freshSourcePath) as IndexEntry[];
    if (vanishedMatches.length !== 1) continue; // Y matched by more than one vanished entry: ambiguous
    moves.push({ vanished: x, freshSourcePath });
  }
  return moves;
}

/**
 * Mirrors `applyAdoptions`: grafts a page into the by-source-path index under a source path
 * other than the one it currently occupies. The vanished entry's key is removed first, so the
 * leftover scan (which walks the same map) does not report the moved page as an orphan in the
 * very run that moves it. Once grafted, `buildPlan` derives `move` — or `update`, for a
 * same-folder rename — on its own, from comparing the grafted `parentId` against the tree.
 *
 * `contentHash` is always reset to `null`: a same-folder rename keeps parent, title and body
 * unchanged, so a preserved hash would make `buildPlan` classify it as `skip`, and execution
 * would never reach the property write that records the new `source-path` — the stale value
 * would persist and the next run would rediscover the same "vanished" entry.
 *
 * `attachmentHashes`, unlike `contentHash`, is carried forward unchanged: a detected move is
 * proof this is the same page, so its upload state is still valid. Resetting it would
 * re-upload every attachment through the legacy endpoint for zero actual content change.
 */
export function applyMoves(moves: readonly DetectedMove[], bySourcePath: Map<string, IndexEntry>): void {
  for (const { vanished, freshSourcePath } of moves) {
    if (vanished.sourcePath !== null) bySourcePath.delete(vanished.sourcePath);
    bySourcePath.set(freshSourcePath, {
      pageId: vanished.pageId,
      title: vanished.title,
      parentId: vanished.parentId,
      sourcePath: freshSourcePath,
      synthetic: false,
      contentHash: null,
      attachmentHashes: vanished.attachmentHashes,
    });
  }
}

/**
 * `sourceExists` defaults to "everything exists", reproducing the plain wording for callers
 * that don't pass it.
 *
 * A `foreign-source-path` conflict whose occupant's source file no longer exists is the
 * signature of a move combined with an edit in the same commit: `detectMoves` requires title
 * *and* body to match exactly, so an edited-while-moved file fails and is never grafted away,
 * leaving the old page's stale entry to collide with the new file's title. The preflight still
 * aborts in that case, but names the vanished source and the two-step remedy (publish the
 * move, then the edit) instead of leaving a bare page of API ids.
 */
export function formatConflicts(
  conflicts: readonly TitleConflict[],
  sourceExists: (sourcePath: string) => boolean = () => true,
): string {
  const lines = conflicts.map((conflict) => {
    switch (conflict.reason) {
      case 'internal-duplicate':
        return `- "${conflict.title}" is claimed by ${conflict.sources.join(', ')}. Add an explicit H1 or a front matter "title" field to one of them.`;
      case 'foreign-source-path': {
        const occupantSourcePath = conflict.occupantSourcePath;
        if (occupantSourcePath !== null && !sourceExists(occupantSourcePath)) {
          return `- "${conflict.title}" (requested by ${conflict.sources[0]}) is already used by page ${conflict.occupantPageId}, which belongs to ${occupantSourcePath}, whose source file no longer exists. If you moved this file and edited it in the same commit, publish the move first, then the edit.`;
        }
        return `- "${conflict.title}" (requested by ${conflict.sources[0]}) is already used by page ${conflict.occupantPageId}, which belongs to ${occupantSourcePath}.`;
      }
      case 'non-current-status':
        return `- "${conflict.title}" (requested by ${conflict.sources[0]}) is occupied by page ${conflict.occupantPageId} in status "${conflict.occupantStatus}". Purge it from the trash or choose a different title.`;
      case 'ambiguous-match':
        return `- "${conflict.title}" (requested by ${conflict.sources[0]}) matches more than one page in the space: adoption would be ambiguous.`;
      case 'untracked-occupant':
        return `- "${conflict.title}" (requested by ${conflict.sources[0]}) is held by untracked page ${conflict.occupantPageId}, while that source already has a page of its own. Rename one of the two, or delete the untracked page.`;
    }
  });
  return `Title preflight failed with ${conflicts.length} conflict(s):\n${lines.join('\n')}`;
}
