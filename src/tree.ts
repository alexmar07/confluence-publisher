import { normaliseFolderPath } from './config.js';
import type { ParsedDocument } from './markdown/parse.js';
import { titleFromFolderName } from './markdown/parse.js';

export interface PageNode {
  sourcePath: string;
  synthetic: boolean;
  title: string;
  document: ParsedDocument | null;
  children: PageNode[];
}

interface FolderBucket {
  path: string; // repo-relative, with trailing '/'; '' for the publication root
  files: ParsedDocument[];
  subfolders: Map<string, FolderBucket>;
}

const CONTAINER_NAMES = ['README.md', 'index.md'];

function emptyBucket(path: string): FolderBucket {
  return { path, files: [], subfolders: new Map() };
}

/** Groups documents by the folder chain that separates them from the publication root. */
function bucketise(documents: readonly ParsedDocument[], folder: string): FolderBucket {
  const prefix = folder === '' ? '' : `${folder}/`;
  const root = emptyBucket(prefix);
  for (const doc of documents) {
    const relative = doc.sourcePath.startsWith(prefix)
      ? doc.sourcePath.slice(prefix.length)
      : doc.sourcePath;
    const parts = relative.split('/');
    let bucket = root;
    for (const segment of parts.slice(0, -1)) {
      let child = bucket.subfolders.get(segment);
      if (!child) {
        child = emptyBucket(`${bucket.path}${segment}/`);
        bucket.subfolders.set(segment, child);
      }
      bucket = child;
    }
    bucket.files.push(doc);
  }
  return root;
}

function containerOf(bucket: FolderBucket): ParsedDocument | undefined {
  for (const name of CONTAINER_NAMES) {
    const found = bucket.files.find((doc) => doc.sourcePath === `${bucket.path}${name}`);
    if (found) return found;
  }
  return undefined;
}

function leafNode(document: ParsedDocument): PageNode {
  return {
    sourcePath: document.sourcePath,
    synthetic: false,
    title: document.title,
    document,
    children: [],
  };
}

/**
 * Returns the nodes that hang directly under `bucket`.
 * The publication root has no page of its own: its children hang under `parent-page-id`.
 */
function nodesOf(bucket: FolderBucket, isRoot: boolean): PageNode[] {
  const container = isRoot ? undefined : containerOf(bucket);
  const leaves = bucket.files
    .filter((doc) => doc !== container)
    .map(leafNode)
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

  const subtrees = [...bucket.subfolders.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((sub) => subtreeOf(sub));

  const children = [...subtrees, ...leaves];
  if (isRoot) return children;

  if (container) {
    const node = leafNode(container);
    node.children = children;
    return [node];
  }

  return [
    {
      sourcePath: bucket.path,
      synthetic: true,
      title: titleFromFolderName(bucket.path),
      document: null,
      children,
    },
  ];
}

function subtreeOf(bucket: FolderBucket): PageNode {
  const nodes = nodesOf(bucket, false);
  return nodes[0] as PageNode;
}

export function buildTree(documents: readonly ParsedDocument[], folder: string): PageNode[] {
  // Normalise here too (not only in parseConfig), so "./docs" and "docs" always bucketise
  // identically, regardless of caller.
  return nodesOf(bucketise(documents, normaliseFolderPath(folder)), true);
}

export function flattenTree(roots: readonly PageNode[]): PageNode[] {
  const out: PageNode[] = [];
  const walk = (nodes: readonly PageNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

export function maxDepth(roots: readonly PageNode[]): number {
  if (roots.length === 0) return 0;
  return 1 + Math.max(...roots.map((node) => maxDepth(node.children)));
}
