import type { Heading, Root, RootContent } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { TitleStrategy } from '../config.js';

export interface ParsedDocument {
  sourcePath: string;
  root: Root;
  frontmatter: Readonly<Record<string, string>>;
  title: string;
  isEmpty: boolean;
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);

/**
 * Minimal front matter reader: flat `key: value` scalar pairs only. A full YAML parser would
 * exceed the action's runtime dependency budget, and the only field consumed is `title`.
 */
function readFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Matching against the raw (untrimmed) line is what distinguishes a top-level scalar from a
  // nested key or a block-scalar continuation line; trimming first lets an indented `title:` under
  // some other key overwrite the real top-level title. remark-frontmatter preserves whichever line
  // ending the source file uses inside the fence body, so splitting must recognise CRLF and bare
  // CR: on "\n" alone every line but the last keeps a trailing "\r", which the anchored regex
  // below can never match to its end, dropping the front matter entirely on a CRLF checkout.
  for (const line of raw.split(/\r\n|\r|\n/)) {
    // A line starting with `-` is a YAML sequence item, not a scalar key, regardless of
    // indentation. A separate indentation check is unnecessary: the key pattern below is anchored
    // at `^` and its character class contains no whitespace, so an indented line already fails.
    if (line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Flattens inline markdown to plain text: emphasis, code and links keep only their text. */
export function stripInlineMarkdown(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[]; alt?: string };
  if (typeof n.value === 'string') return n.value;
  if (n.type === 'image') return n.alt ?? '';
  if (Array.isArray(n.children)) return n.children.map(stripInlineMarkdown).join('');
  return '';
}

function humanise(name: string): string {
  return name.replace(/[-_]+/g, ' ').trim();
}

export function titleFromFilename(sourcePath: string): string {
  const base = sourcePath.split('/').pop() ?? sourcePath;
  return humanise(base.replace(/\.mdx?$/i, ''));
}

export function titleFromFolderName(folderPath: string): string {
  const trimmed = folderPath.replace(/\/+$/, '');
  const base = trimmed.split('/').pop() ?? trimmed;
  return humanise(base);
}

function firstH1(root: Root): Heading | undefined {
  return root.children.find(
    (child): child is Heading => child.type === 'heading' && child.depth === 1,
  );
}

function isContentNode(node: RootContent): boolean {
  // Only the "yaml" fence is registered with remark-frontmatter (see `processor` above),
  // so "toml" nodes never occur and are intentionally not checked here.
  return node.type !== 'yaml';
}

export function parseMarkdown(
  sourcePath: string,
  content: string,
  strategy: TitleStrategy,
): ParsedDocument {
  const root = processor.parse(content);
  const yamlNode = root.children.find((child) => child.type === 'yaml');
  const frontmatter =
    yamlNode && 'value' in yamlNode ? readFrontmatter(String(yamlNode.value)) : {};

  const headingTitle = (() => {
    const heading = firstH1(root);
    if (!heading) return '';
    return stripInlineMarkdown(heading).trim();
  })();

  const fromFile = titleFromFilename(sourcePath);
  const fromFrontmatter = (frontmatter.title ?? '').trim();

  let title: string;
  if (strategy === 'filename') {
    title = fromFile;
  } else if (strategy === 'frontmatter') {
    title = fromFrontmatter || headingTitle || fromFile;
  } else {
    title = headingTitle || fromFile;
  }

  return {
    sourcePath,
    root,
    frontmatter,
    title,
    isEmpty: root.children.filter(isContentNode).length === 0,
  };
}
