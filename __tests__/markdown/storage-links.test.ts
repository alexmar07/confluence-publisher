import type { Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/markdown/parse.js';
import type { ParsedDocument } from '../../src/markdown/parse.js';
import { composeBody, renderFooter, toStorage } from '../../src/markdown/storage.js';

const titles = new Map<string, string>([
  ['docs/integrations/tconnect.md', 'TConnect Guide'],
  ['docs/README.md', 'Documentation'],
]);

const render = (markdown: string, from = 'docs/integrations/index.md') =>
  toStorage(parseMarkdown(from, markdown, 'h1'), {
    currentSourcePath: from,
    titlesBySourcePath: titles,
    mermaidMacro: 'code',
  });

describe('relative links', () => {
  it('converts a sibling link into a native confluence page link', () => {
    const { xhtml } = render('see [the guide](./tconnect.md)\n');
    expect(xhtml).toContain('<ac:link><ri:page ri:content-title="TConnect Guide"/>');
    expect(xhtml).toContain('<ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body>');
    expect(xhtml).not.toContain('ac:anchor');
  });

  it('places the anchor on the ac:link tag', () => {
    const { xhtml } = render('see [the guide](../integrations/tconnect.md#section-two)\n');
    expect(xhtml).toContain('<ac:link ac:anchor="section-two"><ri:page ri:content-title="TConnect Guide"/>');
  });

  it('resolves a parent-relative link', () => {
    const { xhtml } = render('see [index](../README.md)\n');
    expect(xhtml).toContain('ri:content-title="Documentation"');
  });

  it('degrades an unresolved target to plain text and warns without failing', () => {
    const { xhtml, warnings } = render('see [missing](./missing.md)\n');
    expect(xhtml).toContain('see missing');
    expect(xhtml).not.toContain('ac:link');
    expect(warnings.some((w) => w.includes('docs/integrations/missing.md'))).toBe(true);
  });

  it('leaves absolute links as ordinary anchors', () => {
    const { xhtml } = render('see [site](https://example.com/x?a=1&b=2)\n');
    expect(xhtml).toContain('<a href="https://example.com/x?a=1&amp;b=2">site</a>');
  });

  it('escapes a double quote appearing in a resolved title', () => {
    const { xhtml } = toStorage(parseMarkdown('docs/a.md', '[x](./b.md)\n', 'h1'), {
      currentSourcePath: 'docs/a.md',
      titlesBySourcePath: new Map([['docs/b.md', 'Title "quoted"']]),
      mermaidMacro: 'code',
    });
    expect(xhtml).toContain('ri:content-title="Title &quot;quoted&quot;"');
  });
});

describe('images', () => {
  it('registers a relative image as an attachment and references it by filename', () => {
    const { xhtml, attachments } = render('![schema](../img/flow.png)\n');
    expect(xhtml).toContain('<ac:image ac:alt="schema"><ri:attachment ri:filename="flow.png"/></ac:image>');
    expect(attachments).toEqual([{ sourcePath: 'docs/img/flow.png', filename: 'flow.png' }]);
  });

  it('does not register the same attachment twice', () => {
    const { attachments } = render('![a](./x.png)\n\n![b](./x.png)\n');
    expect(attachments).toHaveLength(1);
  });

  it('keeps a remote image as a url reference', () => {
    const { xhtml, attachments } = render('![remote](https://example.com/a.png)\n');
    expect(xhtml).toContain('<ac:image ac:alt="remote"><ri:url ri:value="https://example.com/a.png"/></ac:image>');
    expect(attachments).toEqual([]);
  });

  it('warns when two different images share the same basename on one page', () => {
    const { warnings } = render('![a](./one/x.png)\n\n![b](./two/x.png)\n');
    expect(warnings.some((w) => w.includes('x.png'))).toBe(true);
  });
});

// `node.alt` was already threaded through to `image()` (imageReference() explicitly passes
// `alt: node.alt ?? null`) but `image()` never read it, so every published image silently lost
// its alt text — an accessibility regression against the source Markdown. Confluence Cloud v2
// accepts and round-trips `ac:alt` verbatim. `node.alt` can only be `undefined` via a hand-built
// node (real Markdown image syntax always produces at least an empty string), so the "alt
// absent" case below builds the tree directly, the same way the dangling-reference tests above do.
describe('image alt text (N2)', () => {
  const renderImageNode = (alt: string | null | undefined, url: string): { xhtml: string } => {
    const root: Root = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'image', url, alt, title: null }] }],
    };
    return toStorage(
      { sourcePath: 'docs/a.md', root, frontmatter: {}, title: 'a', isEmpty: false },
      { currentSourcePath: 'docs/a.md', titlesBySourcePath: titles, mermaidMacro: 'code' },
    );
  };

  describe('absolute-URL form', () => {
    it('emits ac:alt when alt is present', () => {
      const { xhtml } = render('![Diagram](https://example.com/a.png)\n');
      expect(xhtml).toContain('<ac:image ac:alt="Diagram"><ri:url ri:value="https://example.com/a.png"/></ac:image>');
    });

    it('omits ac:alt when alt is absent (undefined)', () => {
      const { xhtml } = renderImageNode(undefined, 'https://example.com/a.png');
      expect(xhtml).toBe('<p><ac:image><ri:url ri:value="https://example.com/a.png"/></ac:image></p>');
      expect(xhtml).not.toContain('ac:alt');
    });

    it('omits ac:alt when alt is an empty string', () => {
      const { xhtml } = render('![](https://example.com/a.png)\n');
      expect(xhtml).toBe('<p><ac:image><ri:url ri:value="https://example.com/a.png"/></ac:image></p>');
      expect(xhtml).not.toContain('ac:alt');
    });

    it('escapes an alt value containing characters that must be escaped', () => {
      const { xhtml } = renderImageNode('A & B <x> "q"', 'https://example.com/a.png');
      expect(xhtml).toContain('ac:alt="A &amp; B &lt;x&gt; &quot;q&quot;"');
    });
  });

  describe('attachment form', () => {
    it('emits ac:alt when alt is present', () => {
      const { xhtml } = render('![Diagram](../img/flow.png)\n');
      expect(xhtml).toContain('<ac:image ac:alt="Diagram"><ri:attachment ri:filename="flow.png"/></ac:image>');
    });

    it('omits ac:alt when alt is absent (undefined)', () => {
      const { xhtml } = renderImageNode(undefined, '../img/flow.png');
      expect(xhtml).toBe('<p><ac:image><ri:attachment ri:filename="flow.png"/></ac:image></p>');
      expect(xhtml).not.toContain('ac:alt');
    });

    it('omits ac:alt when alt is an empty string', () => {
      const { xhtml } = render('![](../img/flow.png)\n');
      expect(xhtml).toBe('<p><ac:image><ri:attachment ri:filename="flow.png"/></ac:image></p>');
      expect(xhtml).not.toContain('ac:alt');
    });

    it('escapes an alt value containing characters that must be escaped', () => {
      const { xhtml } = renderImageNode('A & B <x> "q"', '../img/flow.png');
      expect(xhtml).toContain('ac:alt="A &amp; B &lt;x&gt; &quot;q&quot;"');
    });
  });

  // imageReference() passes `alt: node.alt ?? null` into image(); this pins that the alt text
  // arriving from a reference-style image's own `alt`, not the definition's, reaches the output.
  describe('via imageReference', () => {
    it('forwards the alt text from the reference to the rendered ac:image', () => {
      const { xhtml } = render('![Diagram][img]\n\n[img]: ../img/flow.png\n');
      expect(xhtml).toContain('<ac:image ac:alt="Diagram"><ri:attachment ri:filename="flow.png"/></ac:image>');
    });
  });
});

describe('reference-style links, images and footnotes', () => {
  it('resolves a reference-style link exactly like the equivalent inline link', () => {
    const { xhtml } = render('see [the guide][g]\n\n[g]: ./tconnect.md\n');
    expect(xhtml).toContain('<ac:link><ri:page ri:content-title="TConnect Guide"/>');
    expect(xhtml).toContain('<ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body>');
  });

  it('resolves a shortcut reference link using the link text as the identifier', () => {
    const { xhtml } = render('see [the guide]\n\n[the guide]: ./tconnect.md\n');
    expect(xhtml).toContain('ri:content-title="TConnect Guide"');
  });

  // collectDefinitions walks the whole tree, not only `document.root.children`, specifically so
  // a `definition` nested inside e.g. a blockquote is still found. A block quoted reference-style
  // definition is unusual but syntactically valid CommonMark: remark-parse nests the `definition`
  // node under `blockquote.children`, not at the document root.
  it('resolves a link reference against a definition nested inside a blockquote', () => {
    const { xhtml } = render('> [g]: https://example.com\n\nsee [the guide][g]\n');
    expect(xhtml).toContain('<a href="https://example.com">the guide</a>');
  });

  it('resolves a reference-style image exactly like the equivalent inline image, attachment included', () => {
    const { xhtml, attachments } = render('![schema][img]\n\n[img]: ../img/flow.png\n');
    expect(xhtml).toContain('<ac:image ac:alt="schema"><ri:attachment ri:filename="flow.png"/></ac:image>');
    expect(attachments).toEqual([{ sourcePath: 'docs/img/flow.png', filename: 'flow.png' }]);
  });

  // remark-parse only ever emits a linkReference/imageReference node when a matching `definition`
  // exists somewhere in the document (an unmatched `[x][y]` degrades to literal text during
  // parsing itself, verified by inspecting the parsed tree), so this pipeline path can never
  // reach our resolver with an unresolved identifier. The two tests below exercise the resolver's
  // defensive branch directly, against a hand-built tree, as a guard against a future producer of
  // ParsedDocument (or a remark-plugin regression) that violates that invariant.
  const withDanglingReference = (
    node: { type: 'linkReference' | 'imageReference'; identifier: string; alt?: string },
  ): ParsedDocument => {
    const root: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children:
            node.type === 'linkReference'
              ? [
                  { type: 'text', value: 'see ' },
                  {
                    type: 'linkReference',
                    identifier: node.identifier,
                    referenceType: 'full',
                    children: [{ type: 'text', value: 'missing' }],
                  },
                ]
              : [{ type: 'imageReference', identifier: node.identifier, referenceType: 'full', alt: node.alt }],
        },
      ],
    };
    return { sourcePath: 'docs/a.md', root, frontmatter: {}, title: 'a', isEmpty: false };
  };

  it('warns and degrades to plain text when a link reference has no matching definition', () => {
    const { xhtml, warnings } = toStorage(withDanglingReference({ type: 'linkReference', identifier: 'missing-id' }), {
      currentSourcePath: 'docs/a.md',
      titlesBySourcePath: titles,
      mermaidMacro: 'code',
    });
    expect(xhtml).toContain('see missing');
    expect(xhtml).not.toContain('<ac:link');
    expect(warnings.some((w) => w.includes('missing-id'))).toBe(true);
  });

  it('warns and omits the image when an image reference has no matching definition', () => {
    const { xhtml, warnings, attachments } = toStorage(
      withDanglingReference({ type: 'imageReference', identifier: 'missing-id', alt: 'schema' }),
      { currentSourcePath: 'docs/a.md', titlesBySourcePath: titles, mermaidMacro: 'code' },
    );
    expect(xhtml).not.toContain('ac:image');
    expect(attachments).toEqual([]);
    expect(warnings.some((w) => w.includes('missing-id'))).toBe(true);
  });

  it('does not emit a stray empty paragraph for a link definition', () => {
    const { xhtml } = render('see [the guide][g]\n\n[g]: ./tconnect.md\n');
    expect(xhtml).not.toContain('<p></p>');
  });

  it('keeps a footnote marker and its body visible instead of dropping them', () => {
    const { xhtml } = render('note[^1] important.\n\n[^1]: Body of the note.\n');
    expect(xhtml).toContain('note<sup>[1]</sup> important.');
    expect(xhtml).toContain('Body of the note.');
    expect(xhtml).not.toContain('<p></p>');
  });
});

describe('footer', () => {
  it('renders a permalink to the source file', () => {
    const footer = renderFooter({
      serverUrl: 'https://github.com',
      repository: 'acme/docs',
      sha: 'abc123',
      sourcePath: 'docs/a.md',
    });
    expect(footer).toContain('https://github.com/acme/docs/blob/abc123/docs/a.md');
    expect(footer).toContain('Page generated automatically by confluence-docs-publisher. Source:');
  });

  it('is appended by composeBody and therefore excluded from the hashed body', () => {
    const body = composeBody('<p>x</p>', renderFooter({
      serverUrl: 'https://github.com',
      repository: 'acme/docs',
      sha: 'abc123',
      sourcePath: 'docs/a.md',
    }));
    expect(body.startsWith('<p>x</p>')).toBe(true);
    expect(body).toContain('abc123');
    expect(composeBody('<p>x</p>', null)).toBe('<p>x</p>');
  });
});
