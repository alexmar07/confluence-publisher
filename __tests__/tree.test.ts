import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown/parse.js';
import { buildTree, flattenTree, maxDepth } from '../src/tree.js';

const doc = (path: string, body = '# ' + path + '\n') => parseMarkdown(path, body, 'h1');
const paths = (nodes: { sourcePath: string }[]) => nodes.map((n) => n.sourcePath);

describe('buildTree', () => {
  it('places top-level files at the root', () => {
    const roots = buildTree([doc('docs/a.md'), doc('docs/b.md')], 'docs');
    expect(paths(roots).sort()).toEqual(['docs/a.md', 'docs/b.md']);
  });

  it('promotes README.md to the container page of its folder', () => {
    const roots = buildTree(
      [doc('docs/integrations/README.md'), doc('docs/integrations/x.md')],
      'docs',
    );
    expect(paths(roots)).toEqual(['docs/integrations/README.md']);
    expect(roots[0]!.synthetic).toBe(false);
    expect(paths(roots[0]!.children)).toEqual(['docs/integrations/x.md']);
  });

  it('promotes index.md when README.md is absent', () => {
    const roots = buildTree([doc('docs/sub/index.md'), doc('docs/sub/y.md')], 'docs');
    expect(paths(roots)).toEqual(['docs/sub/index.md']);
  });

  it('prefers README.md over index.md when both exist', () => {
    const roots = buildTree(
      [doc('docs/sub/README.md'), doc('docs/sub/index.md'), doc('docs/sub/y.md')],
      'docs',
    );
    expect(paths(roots)).toEqual(['docs/sub/README.md']);
    expect(paths(roots[0]!.children).sort()).toEqual(['docs/sub/index.md', 'docs/sub/y.md']);
  });

  it('creates a synthetic container for a folder without README or index', () => {
    const roots = buildTree([doc('docs/my_sub-folder/y.md')], 'docs');
    expect(roots[0]!.sourcePath).toBe('docs/my_sub-folder/');
    expect(roots[0]!.synthetic).toBe(true);
    expect(roots[0]!.title).toBe('my sub folder');
    expect(roots[0]!.document).toBeNull();
  });

  it('does not treat the publication root README as a container of the root itself', () => {
    const roots = buildTree([doc('docs/README.md'), doc('docs/a.md')], 'docs');
    expect(paths(roots).sort()).toEqual(['docs/README.md', 'docs/a.md']);
  });

  it('keeps docs/README.md and docs/integrations/README.md as two distinct nodes', () => {
    const roots = buildTree([doc('docs/README.md'), doc('docs/integrations/README.md')], 'docs');
    const all = flattenTree(roots);
    expect(paths(all).sort()).toEqual(['docs/README.md', 'docs/integrations/README.md']);
  });

  it('creates intermediate synthetic containers for a three-level tree', () => {
    const roots = buildTree([doc('docs/superpowers/specs/a.md')], 'docs');
    const all = flattenTree(roots);
    expect(paths(all)).toEqual([
      'docs/superpowers/',
      'docs/superpowers/specs/',
      'docs/superpowers/specs/a.md',
    ]);
  });

  it('lists parents before their children in the flattened order', () => {
    const roots = buildTree([doc('docs/sub/x.md'), doc('docs/sub/README.md')], 'docs');
    const flat = paths(flattenTree(roots));
    expect(flat.indexOf('docs/sub/README.md')).toBeLessThan(flat.indexOf('docs/sub/x.md'));
  });

  it('produces identical trees for a folder given as "./docs" or "docs"', () => {
    // buildTree used to strip only trailing slashes, so a leading "./" survived as part of
    // the prefix, the startsWith(prefix) match against repo-relative source paths failed, and a
    // spurious synthetic "docs" container wrapped the whole tree.
    const documents = [doc('docs/a.md'), doc('docs/sub/b.md')];
    const withDotSlash = buildTree(documents, './docs');
    const withoutDotSlash = buildTree(documents, 'docs');
    expect(paths(flattenTree(withDotSlash))).toEqual(paths(flattenTree(withoutDotSlash)));
    expect(paths(withDotSlash).sort()).toEqual(['docs/a.md', 'docs/sub/']);
  });

  it('orders subfolders before sibling files at the root level', () => {
    // Kills the mutant that assembles children as [...leaves, ...subtrees]. The names are
    // chosen so that a plain alphabetical sort of the combined set would put "zeta" last.
    const roots = buildTree(
      [doc('docs/zeta/x.md'), doc('docs/alpha.md'), doc('docs/beta.md')],
      'docs',
    );
    expect(paths(roots)).toEqual(['docs/zeta/', 'docs/alpha.md', 'docs/beta.md']);
  });

  it('orders subfolders before sibling files at a nested level', () => {
    // nodesOf returns nested levels through a different branch than the root, so the rule
    // has to be pinned on both sides.
    const roots = buildTree(
      [doc('docs/nested/zeta/x.md'), doc('docs/nested/alpha.md'), doc('docs/nested/beta.md')],
      'docs',
    );
    expect(paths(roots)).toEqual(['docs/nested/']);
    expect(paths(roots[0]!.children)).toEqual([
      'docs/nested/zeta/',
      'docs/nested/alpha.md',
      'docs/nested/beta.md',
    ]);
  });

  it('reports the maximum depth of the tree', () => {
    expect(maxDepth(buildTree([doc('docs/a.md')], 'docs'))).toBe(1);
    expect(maxDepth(buildTree([doc('docs/superpowers/specs/a.md')], 'docs'))).toBe(3);
  });
});
