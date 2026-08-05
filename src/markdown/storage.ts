import type {
  Code,
  Definition,
  Image,
  ImageReference,
  Link,
  LinkReference,
  List,
  ListItem,
  Node,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import type { ParsedDocument } from './parse.js';

export interface AttachmentRef {
  sourcePath: string;
  filename: string;
}

export interface StorageContext {
  currentSourcePath: string;
  titlesBySourcePath: ReadonlyMap<string, string>;
  mermaidMacro: string;
}

export interface StorageResult {
  xhtml: string;
  attachments: AttachmentRef[];
  warnings: string[];
}

/** Languages accepted by the Confluence code macro; anything else degrades to `text`. */
const CODE_LANGUAGES = new Set([
  'actionscript3',
  'applescript',
  'bash',
  'c#',
  'cpp',
  'css',
  'coldfusion',
  'delphi',
  'diff',
  'erl',
  'groovy',
  'html/xml',
  'java',
  'javafx',
  'javascript',
  'json',
  'perl',
  'php',
  'powershell',
  'python',
  'ruby',
  'scala',
  'sql',
  'sh',
  'text',
  'vb',
  'yaml',
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'javascript',
  typescript: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  tsx: 'javascript',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  html: 'html/xml',
  xml: 'html/xml',
  md: 'text',
  markdown: 'text',
  csharp: 'c#',
  'c++': 'cpp',
  py: 'python',
  rb: 'ruby',
};

/**
 * Matches one HTML comment span at a time (non-greedy). A single raw-html node can hold several
 * comments plus the text between them, so a greedy full-value match would span from the first
 * `<!--` to the *last* `-->` and swallow that text along with the comments.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** `br`/`hr` are accepted only bare, with no attributes. */
const BARE_SELF_CLOSING_HTML = /^<(br|hr)\s*\/?>$/i;

/**
 * A `<` that can actually begin markup — a tag (`<p`, `</p`), a declaration or comment (`<!`), or
 * a processing instruction (`<?`). Prose such as "5 < 10" contains a `<` but no markup, and must
 * not be reported as escaped raw HTML.
 */
const TAG_LIKE = /<[A-Za-z/!?]/;

/** `img` is accepted with an attribute list; each attribute is validated individually below. */
const IMG_TAG = /^<img\b\s*([\s\S]*?)\s*\/?>$/i;

/** A single double-quoted `name="value"` attribute, consumed one at a time from the tag body. */
const IMG_ATTRIBUTE = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*"([^"]*)"/;

/** Attribute names accepted on a safe `img` tag; anything else voids the whole tag. */
const IMG_ATTRIBUTE_WHITELIST = new Set(['src', 'alt', 'title', 'width', 'height']);

/**
 * Escapes every `&` unconditionally instead of looking ahead for a valid entity: micromark has
 * already decoded every valid character reference in text (an author-typed `&amp;` arrives as a
 * literal `&`), so any `&xxx;` still present is not a valid entity and must be escaped like a bare
 * `&` for the output to be well-formed XML.
 *
 * This does NOT hold for raw HTML: micromark copies an mdast `html` node's `value` verbatim and
 * never decodes references inside it, so `&amp;` arrives still as `&amp;` and would double-escape
 * into `&amp;amp;`. Raw HTML attribute values must go through {@link escapeRawAttributeValue}
 * instead, never through this function.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The XML 1.0 `Char` production: the range a numeric character reference may denote, and equally
 * the range a *literal* character may occupy. Anything else — the surrogate-pair gap, anything
 * past the Unicode ceiling — is not legal XML text, however well-formed the reference looks.
 */
function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Matches, one at a time, either a numeric character reference (decimal or hex, captured
 * separately) or a bare `&`. The five XML-defined named entities are matched too, purely so the
 * callback can leave them untouched without their `&` being reconsidered as a bare one.
 */
const RAW_ATTRIBUTE_AMPERSAND = /&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9A-Fa-f]+);|&/g;

/**
 * Escapes an attribute value taken verbatim from raw HTML source (an mdast `html` node), where —
 * unlike ordinary text — micromark has NOT decoded character references. An already-valid entity
 * the author typed (e.g. `&amp;`) must be left alone, or it doubles into `&amp;amp;`; only a bare
 * `&` needs escaping.
 *
 * The exemption must cover exactly the five XML-defined entities (`amp`, `lt`, `gt`, `quot`,
 * `apos`) plus numeric character references, and nothing else. Confluence storage format is XHTML
 * and defines no HTML-only entities: exempting any `&name;` shape lets `&nbsp;` through verbatim,
 * producing a fragment that does not parse as XML and gets the whole page rejected.
 *
 * A numeric reference is exempted only when {@link isValidXmlCodePoint} accepts the code point it
 * denotes; a syntactic-only check passes code points XML 1.0 forbids as text (`&#0;`, `&#xD800;`,
 * `&#x110000;`) through to the same whole-page rejection. Otherwise its `&` is escaped like any
 * other bare ampersand, degrading the reference to inert literal text rather than corrupting the
 * document. No warning is emitted: the document stays well-formed and nothing is dropped.
 */
function escapeRawAttributeValue(value: string): string {
  const withAmpersandsResolved = value.replace(
    RAW_ATTRIBUTE_AMPERSAND,
    (match, decimal: string | undefined, hex: string | undefined) => {
      if (decimal === undefined && hex === undefined) {
        // Either one of the five named entities (leave as-is) or a bare '&' with no recognised
        // entity shape at all (escape it).
        return match.length === 1 ? '&amp;' : match;
      }
      const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex as string, 16);
      if (isValidXmlCodePoint(codePoint)) return match;
      // Escape only the leading '&'; the rest of the reference survives as inert literal text.
      return `&amp;${match.slice(1)}`;
    },
  );
  return withAmpersandsResolved.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function wrapCdata(text: string): string {
  return `<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

/** Normalises `target` against the directory of `fromPath`, both repo-relative. */
function resolveRelativeLink(fromPath: string, target: string): string {
  const segments = fromPath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

function splitAnchor(url: string): { path: string; anchor: string | null } {
  const hash = url.indexOf('#');
  if (hash < 0) return { path: url, anchor: null };
  return { path: url.slice(0, hash), anchor: url.slice(hash + 1) || null };
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:|^\/\//i;

function normaliseLanguage(lang: string | null | undefined): string {
  if (!lang) return 'text';
  const lower = lang.trim().toLowerCase();
  const mapped = LANGUAGE_ALIASES[lower] ?? lower;
  return CODE_LANGUAGES.has(mapped) ? mapped : 'text';
}

function codeMacro(name: string, language: string, value: string): string {
  return (
    `<ac:structured-macro ac:name="${escapeXml(name)}" ac:schema-version="1">` +
    `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>` +
    `<ac:plain-text-body>${wrapCdata(value)}</ac:plain-text-body>` +
    `</ac:structured-macro>`
  );
}

function isTaskList(node: List): boolean {
  return node.children.some((item) => typeof item.checked === 'boolean');
}

function hasChildren(node: Node): node is Node & Parent {
  return Array.isArray((node as Partial<Parent>).children);
}

/**
 * `definition` nodes (`[id]: url "title"`) can occur anywhere a block is admitted, not only at
 * the top level, so this walks the whole tree once.
 */
function collectDefinitions(root: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  const visit = (node: Node): void => {
    if (node.type === 'definition') {
      const definition = node as Definition;
      if (!definitions.has(definition.identifier)) {
        definitions.set(definition.identifier, definition);
      }
    }
    if (hasChildren(node)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return definitions;
}

class Serialiser {
  readonly attachments: AttachmentRef[] = [];
  readonly warnings: string[] = [];
  private readonly seenAttachments = new Map<string, string>();
  private readonly definitions: Map<string, Definition>;

  constructor(
    private readonly ctx: StorageContext,
    root: Root,
  ) {
    this.definitions = collectDefinitions(root);
  }

  block(node: RootContent): string {
    switch (node.type) {
      case 'yaml':
        return '';
      case 'heading': {
        const depth = Math.min(6, Math.max(1, node.depth));
        return `<h${depth}>${this.inlineAll(node.children)}</h${depth}>`;
      }
      case 'paragraph':
        return `<p>${this.inlineAll(node.children)}</p>`;
      case 'blockquote':
        return `<blockquote>${node.children.map((c) => this.block(c)).join('')}</blockquote>`;
      case 'thematicBreak':
        return '<hr/>';
      case 'code':
        return this.code(node);
      case 'list':
        return this.list(node);
      case 'table':
        return this.table(node);
      case 'html':
        return this.rawHtml(node.value);
      case 'definition':
        // Consumed by collectDefinitions(); it carries no visible content of its own.
        return '';
      case 'footnoteDefinition': {
        const marker = `<p><strong>[${escapeXml(node.identifier)}]</strong></p>`;
        return marker + node.children.map((c) => this.block(c)).join('');
      }
      default:
        this.warnings.push(
          `${this.ctx.currentSourcePath}: unsupported markdown block node "${node.type}" was not rendered.`,
        );
        return '';
    }
  }

  private code(node: Code): string {
    const lang = (node.lang ?? '').toLowerCase();
    if (lang === 'mermaid' && this.ctx.mermaidMacro !== 'code') {
      return (
        `<ac:structured-macro ac:name="${escapeXml(this.ctx.mermaidMacro)}" ac:schema-version="1">` +
        `<ac:plain-text-body>${wrapCdata(node.value)}</ac:plain-text-body>` +
        `</ac:structured-macro>`
      );
    }
    const language = lang === 'mermaid' ? 'text' : normaliseLanguage(node.lang);
    return codeMacro('code', language, node.value);
  }

  private list(node: List): string {
    if (isTaskList(node)) {
      const tasks = node.children
        .map((item) => {
          const status = item.checked ? 'complete' : 'incomplete';
          return (
            `<ac:task><ac:task-status>${status}</ac:task-status>` +
            `<ac:task-body>${this.listItemInline(item)}</ac:task-body></ac:task>`
          );
        })
        .join('');
      return `<ac:task-list>${tasks}</ac:task-list>`;
    }
    const tag = node.ordered ? 'ol' : 'ul';
    const items = node.children.map((item) => `<li>${this.listItemInline(item)}</li>`).join('');
    return `<${tag}>${items}</${tag}>`;
  }

  /** A list item holds blocks; a lone paragraph is unwrapped so that <li> stays inline. */
  private listItemInline(item: ListItem): string {
    if (item.children.length === 1 && item.children[0]?.type === 'paragraph') {
      return this.inlineAll(item.children[0].children);
    }
    return item.children.map((c) => this.block(c)).join('');
  }

  private table(node: Table): string {
    const rows = node.children
      .map((row, rowIndex) => {
        const tag = rowIndex === 0 ? 'th' : 'td';
        const cells = row.children
          .map((cell) => `<${tag}>${this.inlineAll(cell.children)}</${tag}>`)
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
    return `<table><tbody>${rows}</tbody></table>`;
  }

  private rawHtml(value: string): string {
    // `withoutComments` keeps the original surrounding whitespace (only used by the escape
    // fallback below); `trimmed` is used purely for classification.
    const withoutComments = value.replace(HTML_COMMENT, '');
    const trimmed = withoutComments.trim();
    if (trimmed === '') {
      // Nothing but comment(s) remain; a comment carries no visible content, so dropping it
      // silently (no warning) is intended, unlike the safe-subset fallback below.
      return '';
    }
    if (BARE_SELF_CLOSING_HTML.test(trimmed)) {
      return trimmed.endsWith('/>') ? trimmed : trimmed.replace(/>$/, '/>');
    }
    const safeImg = this.safeImgTag(trimmed);
    if (safeImg !== null) {
      return safeImg;
    }
    // What remains after comment stripping may be plain prose rather than unsafe raw HTML, and a
    // bare "<" is not evidence of a tag either ("5 < 10" is prose), so warning "raw HTML was
    // escaped" is reserved for genuinely tag-like content. Only the warning narrows; the escaping
    // below is unconditional.
    if (TAG_LIKE.test(trimmed)) {
      this.warnings.push(
        `${this.ctx.currentSourcePath}: raw HTML was escaped because it is not part of the safe subset: ${trimmed.slice(0, 80)}`,
      );
    }
    return escapeXml(withoutComments);
  }

  /**
   * Parses a raw `<img ...>` tag against the attribute whitelist. Returns `null` (never a
   * partially-sanitised tag) unless every attribute is double-quoted, appears once, and is in
   * {@link IMG_ATTRIBUTE_WHITELIST}; malformed attribute syntax falls through the same way.
   */
  private safeImgTag(trimmed: string): string | null {
    const match = IMG_TAG.exec(trimmed);
    if (!match) return null;
    let rest = (match[1] ?? '').trim();
    const seen = new Set<string>();
    const attrs: string[] = [];
    while (rest.length > 0) {
      const attrMatch = IMG_ATTRIBUTE.exec(rest);
      if (!attrMatch) return null;
      const name = (attrMatch[1] as string).toLowerCase();
      const rawValue = attrMatch[2] as string;
      if (!IMG_ATTRIBUTE_WHITELIST.has(name) || seen.has(name)) return null;
      seen.add(name);
      // rawValue is copied verbatim from raw HTML source (never decoded by micromark), so escapeXml
      // here would double-escape an author-typed "&amp;" into "&amp;amp;".
      attrs.push(`${name}="${escapeRawAttributeValue(rawValue)}"`);
      rest = rest.slice(attrMatch[0].length).trimStart();
    }
    return attrs.length > 0 ? `<img ${attrs.join(' ')}/>` : '<img/>';
  }

  inlineAll(nodes: readonly PhrasingContent[]): string {
    return nodes.map((node) => this.inline(node)).join('');
  }

  inline(node: PhrasingContent): string {
    switch (node.type) {
      case 'text':
        return escapeXml(node.value);
      case 'strong':
        return `<strong>${this.inlineAll(node.children)}</strong>`;
      case 'emphasis':
        return `<em>${this.inlineAll(node.children)}</em>`;
      case 'delete':
        return `<span style="text-decoration: line-through;">${this.inlineAll(node.children)}</span>`;
      case 'inlineCode':
        return `<code>${escapeXml(node.value)}</code>`;
      case 'break':
        return '<br/>';
      case 'html':
        return this.rawHtml(node.value);
      case 'link':
        return this.link(node);
      case 'image':
        return this.image(node);
      case 'linkReference':
        return this.linkReference(node);
      case 'imageReference':
        return this.imageReference(node);
      case 'footnoteReference':
        return `<sup>[${escapeXml(node.identifier)}]</sup>`;
      default: {
        // Exhaustive above for the node types remark-parse/remark-gfm produce; this branch guards
        // against a future, currently unregistered phrasing content type.
        const unknownType = (node as { type: string }).type;
        this.warnings.push(
          `${this.ctx.currentSourcePath}: unsupported markdown inline node "${unknownType}" was not rendered.`,
        );
        return '';
      }
    }
  }

  /**
   * Resolves through the `definition` collected up front and then renders exactly like the
   * equivalent inline `link`, rather than degrading to plain text.
   */
  private linkReference(node: LinkReference): string {
    const definition = this.definitions.get(node.identifier);
    if (definition === undefined) {
      this.warnings.push(
        `${this.ctx.currentSourcePath}: reference "${node.identifier}" has no matching link definition; the link degrades to plain text.`,
      );
      return this.inlineAll(node.children);
    }
    return this.link({
      type: 'link',
      url: definition.url,
      title: definition.title ?? null,
      children: node.children,
    });
  }

  /**
   * Resolves through the `definition` collected up front and then renders exactly like the
   * equivalent inline `image`, attachment collection included.
   */
  private imageReference(node: ImageReference): string {
    const definition = this.definitions.get(node.identifier);
    if (definition === undefined) {
      this.warnings.push(
        `${this.ctx.currentSourcePath}: image reference "${node.identifier}" has no matching definition; the image is omitted.`,
      );
      return '';
    }
    return this.image({
      type: 'image',
      url: definition.url,
      alt: node.alt ?? null,
      title: definition.title ?? null,
    });
  }

  private link(node: Link): string {
    const text = this.inlineAll(node.children);
    const url = node.url ?? '';
    if (ABSOLUTE_URL.test(url) || url.startsWith('#')) {
      return `<a href="${escapeXml(url)}">${text}</a>`;
    }
    const { path, anchor } = splitAnchor(url);
    if (!/\.mdx?$/i.test(path)) {
      return `<a href="${escapeXml(url)}">${text}</a>`;
    }
    const resolved = resolveRelativeLink(this.ctx.currentSourcePath, path);
    const title = this.ctx.titlesBySourcePath.get(resolved);
    if (title === undefined) {
      this.warnings.push(
        `${this.ctx.currentSourcePath}: link target "${resolved}" is not part of the published set; the link degrades to plain text.`,
      );
      return text;
    }
    const anchorAttr = anchor === null ? '' : ` ac:anchor="${escapeXml(anchor)}"`;
    const plain = this.plainText(node.children);
    return (
      `<ac:link${anchorAttr}><ri:page ri:content-title="${escapeXml(title)}"/>` +
      `<ac:plain-text-link-body>${wrapCdata(plain)}</ac:plain-text-link-body></ac:link>`
    );
  }

  private image(node: Image): string {
    const url = node.url ?? '';
    // Confluence accepts and round-trips ac:alt verbatim (verified live against Confluence Cloud
    // v2 on 2026-08-03); an absent, null or empty alt omits the attribute entirely rather than
    // emitting ac:alt="".
    const altAttr = node.alt !== null && node.alt !== undefined && node.alt !== '' ? ` ac:alt="${escapeXml(node.alt)}"` : '';
    if (ABSOLUTE_URL.test(url)) {
      return `<ac:image${altAttr}><ri:url ri:value="${escapeXml(url)}"/></ac:image>`;
    }
    const resolved = resolveRelativeLink(this.ctx.currentSourcePath, splitAnchor(url).path);
    const filename = resolved.split('/').pop() ?? resolved;
    const previous = this.seenAttachments.get(filename);
    if (previous === undefined) {
      this.seenAttachments.set(filename, resolved);
      this.attachments.push({ sourcePath: resolved, filename });
    } else if (previous !== resolved) {
      this.warnings.push(
        `${this.ctx.currentSourcePath}: two different images resolve to the attachment name "${filename}" (${previous} and ${resolved}); only the first is uploaded.`,
      );
    }
    return `<ac:image${altAttr}><ri:attachment ri:filename="${escapeXml(filename)}"/></ac:image>`;
  }

  /** Link bodies are CDATA-wrapped, so they carry unescaped text. */
  private plainText(nodes: readonly PhrasingContent[]): string {
    return nodes
      .map((n) => ('value' in n && typeof n.value === 'string' ? n.value : 'children' in n ? this.plainText(n.children) : ''))
      .join('');
  }
}

/**
 * Strips every code point XML 1.0 forbids, counting what it removed. Nothing else guards a
 * *literal* illegal character arriving in the Markdown source: `escapeXml` passes everything but
 * `& < > "` through untouched, `escapeRawAttributeValue` inspects only `&#…;` shapes, and
 * {@link wrapCdata} cannot escape anything at all. A stray NUL, a lone surrogate from a truncated
 * emoji or a form feed makes Confluence reject the *whole page body* on parse.
 *
 * Applied once to the renderer's fully assembled output, it covers text, attribute values and
 * CDATA alike in a single pass, and cannot disturb escaping since none of `& < > "` is ever
 * removed. The footer {@link renderFooter} appends downstream is outside this pass.
 *
 * Iteration is by **code point** (`for…of` over a string), not by UTF-16 code unit, so a correctly
 * paired astral character is judged once and survives intact, while a *lone* surrogate iterates as
 * a code point in `0xD800`–`0xDFFF` and is rejected.
 */
function stripInvalidXmlCodePoints(xhtml: string): { text: string; removed: number } {
  let kept = '';
  let removed = 0;
  for (const character of xhtml) {
    // `for…of` never yields an empty string, so `codePointAt(0)` is always defined; the fallback
    // exists only to avoid a non-null assertion.
    const codePoint = character.codePointAt(0) ?? 0;
    if (isValidXmlCodePoint(codePoint)) kept += character;
    else removed += 1;
  }
  // Returning the original string keeps already-valid input byte-identical.
  return removed === 0 ? { text: xhtml, removed: 0 } : { text: kept, removed };
}

export function toStorage(document: ParsedDocument, context: StorageContext): StorageResult {
  const serialiser = new Serialiser(context, document.root);
  const rendered = document.root.children.map((node) => serialiser.block(node)).join('');
  const { text: xhtml, removed } = stripInvalidXmlCodePoints(rendered);
  if (removed > 0) {
    // One warning per rendered file, never one per character: a NUL-riddled file must not emit
    // ten thousand identical lines into the runner log.
    serialiser.warnings.push(
      `${context.currentSourcePath}: removed ${removed} code point(s) that XML 1.0 does not allow; Confluence would have rejected the whole page body.`,
    );
  }
  return { xhtml, attachments: serialiser.attachments, warnings: serialiser.warnings };
}

export interface FooterInfo {
  serverUrl: string;
  repository: string;
  sha: string;
  sourcePath: string;
}

/**
 * The footer embeds the current commit SHA and therefore changes on every push. It is deliberately
 * kept out of StorageResult.xhtml so that the idempotency hash stays stable when the document
 * content has not changed.
 */
export function renderFooter(info: FooterInfo): string {
  const permalink = `${info.serverUrl}/${info.repository}/blob/${info.sha}/${info.sourcePath}`;
  return (
    '<hr/><p><em>Page generated automatically by confluence-docs-publisher. Source: ' +
    `<a href="${escapeXml(permalink)}">${escapeXml(info.sourcePath)}</a></em></p>`
  );
}

export function composeBody(xhtml: string, footer: string | null): string {
  return footer === null ? xhtml : `${xhtml}${footer}`;
}
