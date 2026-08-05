import { describe, expect, it } from 'vitest';
import { parseMarkdown, titleFromFilename, titleFromFolderName } from '../../src/markdown/parse.js';

describe('title derivation', () => {
  it('uses the first level-1 heading with the h1 strategy', () => {
    const doc = parseMarkdown('docs/a.md', '# Quick guide\n\ntext\n', 'h1');
    expect(doc.title).toBe('Quick guide');
  });

  it('strips markdown syntax from the heading', () => {
    const doc = parseMarkdown('docs/a.md', '# **Quick** `guide` [to TConnect](x.md)\n', 'h1');
    expect(doc.title).toBe('Quick guide to TConnect');
  });

  it('ignores headings of level greater than 1', () => {
    const doc = parseMarkdown('docs/getting-started.md', '## Section\n\ntext\n', 'h1');
    expect(doc.title).toBe('getting started');
  });

  it('falls back to the filename when no h1 exists', () => {
    const doc = parseMarkdown('docs/integrations/t_connect-api.md', 'text\n', 'h1');
    expect(doc.title).toBe('t connect api');
  });

  it('uses the filename with the filename strategy even when an h1 exists', () => {
    const doc = parseMarkdown('docs/my-page.md', '# Ignored\n', 'filename');
    expect(doc.title).toBe('my page');
  });

  it('uses the front matter title with the frontmatter strategy', () => {
    const doc = parseMarkdown('docs/a.md', '---\ntitle: From front matter\n---\n\n# Ignored\n', 'frontmatter');
    expect(doc.title).toBe('From front matter');
  });

  it('falls back to h1 then filename when the front matter title is absent', () => {
    const doc = parseMarkdown('docs/a.md', '---\nauthor: x\n---\n\n# From the heading\n', 'frontmatter');
    expect(doc.title).toBe('From the heading');
  });

  it('reads quoted front matter values', () => {
    const doc = parseMarkdown('docs/a.md', '---\ntitle: "With: a colon"\n---\n', 'frontmatter');
    expect(doc.frontmatter.title).toBe('With: a colon');
  });

  it('does not let an indented nested key overwrite the top-level scalar of the same name', () => {
    // `seo:\n  title: Nested title` must not make `frontmatter.title` become the nested
    // value; the nested `title:` line is indented and therefore not a top-level key at all.
    const doc = parseMarkdown(
      'docs/a.md',
      '---\ntitle: Real title\nseo:\n  title: Nested title\n---\n',
      'frontmatter',
    );
    expect(doc.frontmatter.title).toBe('Real title');
    expect(doc.frontmatter.seo).toBe('');
  });

  it('does not treat an indented block-scalar continuation line as a top-level key', () => {
    const doc = parseMarkdown(
      'docs/a.md',
      '---\ntitle: Real title\ndescription: |\n  title: Nested\n---\n',
      'frontmatter',
    );
    expect(doc.frontmatter.title).toBe('Real title');
  });

  it('reads a front matter title from a file using CRLF line endings', () => {
    // Matching against the raw line stopped trimming the trailing \r that remark-frontmatter
    // preserves inside the fence body on a CRLF checkout, so `(.*)$` could never reach `$`
    // (a \r is not matched by `.`) and the whole line failed to match.
    const doc = parseMarkdown(
      'docs/a.md',
      '---\r\ntitle: Real title\r\nauthor: x\r\n---\r\n\r\ntext\r\n',
      'frontmatter',
    );
    expect(doc.frontmatter.title).toBe('Real title');
    expect(doc.frontmatter.author).toBe('x');
    expect(doc.title).toBe('Real title');
  });

  it('derives a container title from a folder path', () => {
    expect(titleFromFolderName('docs/my_sub-folder/')).toBe('my sub folder');
  });

  it('derives a title from a filename regardless of directory', () => {
    expect(titleFromFilename('docs/integrations/README.md')).toBe('README');
  });
});

describe('empty documents', () => {
  it('flags a file with no content beyond the front matter', () => {
    const doc = parseMarkdown('docs/a.md', '---\ntitle: Empty\n---\n\n', 'h1');
    expect(doc.isEmpty).toBe(true);
    expect(doc.title).toBe('a');
  });

  it('does not flag a file with a single paragraph', () => {
    expect(parseMarkdown('docs/a.md', 'text\n', 'h1').isEmpty).toBe(false);
  });
});
