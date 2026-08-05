import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/markdown/parse.js';
import { escapeXml, toStorage, wrapCdata } from '../../src/markdown/storage.js';

const ctx = {
  currentSourcePath: 'docs/a.md',
  titlesBySourcePath: new Map<string, string>(),
  mermaidMacro: 'code',
};

const render = (markdown: string) => toStorage(parseMarkdown('docs/a.md', markdown, 'h1'), ctx);

describe('escaping', () => {
  it('escapes angle brackets and quotes', () => {
    expect(escapeXml('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;');
  });

  it('splits a CDATA terminator inside the payload', () => {
    expect(wrapCdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>');
  });

  // micromark decodes every *valid* character reference before the serialiser ever sees the
  // text (`&amp;` in a paragraph arrives as a literal `&`), so the only `&xxx;` sequences that
  // survive parsing are the ones that are NOT valid entities — exactly the ones a lookahead-based
  // escapeXml would let through unescaped, producing non-well-formed storage XHTML.
  it('escapes a bare ampersand reaching the pipeline through an ordinary paragraph', () => {
    const { xhtml } = render('a & b\n');
    expect(xhtml).toBe('<p>a &amp; b</p>');
  });

  it('escapes an undefined entity-like sequence instead of publishing it verbatim', () => {
    const { xhtml } = render('Use &myvar; as a placeholder\n');
    expect(xhtml).toBe('<p>Use &amp;myvar; as a placeholder</p>');
  });

  it('escapes a literal ampersand-entity sequence typed inside inline code', () => {
    // micromark does not decode character references inside code spans, so the author's literal
    // `&amp;` text must itself come out escaped, not rendered as a live entity.
    const { xhtml } = render('`&amp;`\n');
    expect(xhtml).toContain('<code>&amp;amp;</code>');
  });
});

describe('block conversion', () => {
  it('renders headings and paragraphs', () => {
    const { xhtml } = render('# Title\n\nfirst *paragraph*\n');
    expect(xhtml).toContain('<h1>Title</h1>');
    expect(xhtml).toContain('<p>first <em>paragraph</em></p>');
  });

  it('renders a fenced block as a code macro carrying its language', () => {
    const { xhtml } = render('```python\nprint("x")\n```\n');
    expect(xhtml).toContain('<ac:structured-macro ac:name="code" ac:schema-version="1">');
    expect(xhtml).toContain('<ac:parameter ac:name="language">python</ac:parameter>');
    expect(xhtml).toContain('<ac:plain-text-body><![CDATA[print("x")]]></ac:plain-text-body>');
  });

  it('maps an unsupported language to text', () => {
    const { xhtml } = render('```hcl\nfoo = 1\n```\n');
    expect(xhtml).toContain('<ac:parameter ac:name="language">text</ac:parameter>');
  });

  it('escapes a CDATA terminator appearing inside a code fence', () => {
    const { xhtml } = render('```\nconst x = "a]]>b";\n```\n');
    expect(xhtml).toContain(']]]]><![CDATA[>');
    expect(xhtml).not.toMatch(/CDATA\[[^\]]*]]>b/);
  });

  it('renders a mermaid fence as a code macro with language text by default', () => {
    const { xhtml } = render('```mermaid\ngraph TD;\n```\n');
    expect(xhtml).toContain('ac:name="code"');
    expect(xhtml).toContain('<ac:parameter ac:name="language">text</ac:parameter>');
  });

  it('honours an alternative mermaid macro', () => {
    const { xhtml } = toStorage(parseMarkdown('docs/a.md', '```mermaid\ngraph TD;\n```\n', 'h1'), {
      ...ctx,
      mermaidMacro: 'mermaid-cloud',
    });
    expect(xhtml).toContain('<ac:structured-macro ac:name="mermaid-cloud"');
  });

  it('renders a gfm table with a header row', () => {
    const { xhtml } = render('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(xhtml).toContain('<table><tbody><tr><th>a</th><th>b</th></tr>');
    expect(xhtml).toContain('<tr><td>1</td><td>2</td></tr></tbody></table>');
  });

  it('renders task list items as a confluence task list', () => {
    const { xhtml } = render('- [ ] to do\n- [x] done\n');
    expect(xhtml).toContain('<ac:task-list>');
    expect(xhtml).toContain('<ac:task-status>incomplete</ac:task-status>');
    expect(xhtml).toContain('<ac:task-status>complete</ac:task-status>');
    expect(xhtml).toContain('<ac:task-body>to do</ac:task-body>');
  });

  it('renders a plain bullet list as ul when no item is a task', () => {
    const { xhtml } = render('- one\n- two\n');
    expect(xhtml).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(xhtml).not.toContain('ac:task-list');
  });

  it('renders blockquotes, rules and inline code', () => {
    const { xhtml } = render('> quote\n\n---\n\ntext `code`\n');
    expect(xhtml).toContain('<blockquote><p>quote</p></blockquote>');
    expect(xhtml).toContain('<hr/>');
    expect(xhtml).toContain('<code>code</code>');
  });

  it('keeps a safe self-closed inline tag and escapes everything else', () => {
    const { xhtml, warnings } = render('line<br/>wrapped\n\n<div onclick="x">dangerous</div>\n');
    expect(xhtml).toContain('line<br/>wrapped');
    expect(xhtml).toContain('&lt;div onclick=&quot;x&quot;&gt;');
    expect(warnings.some((w) => w.includes('HTML'))).toBe(true);
  });

  it('drops an HTML comment silently instead of publishing it as visible text', () => {
    const { xhtml, warnings } = render('<!-- note -->\n\ntext\n');
    expect(xhtml).toBe('<p>text</p>');
    expect(warnings).toEqual([]);
  });

  it('drops an inline HTML comment within a paragraph', () => {
    const { xhtml } = render('before <!-- toc --> after\n');
    expect(xhtml).toBe('<p>before  after</p>');
  });

  // micromark lumps "<!-- toc -->General index<!-- /toc -->" into a single `html` node whose
  // value spans both comments and the text between them. A greedy `/^<!--[\s\S]*-->$/` test
  // matches the whole thing (first "<!--" to last "-->") and drops it all, silently losing
  // "General index". Each comment must be dropped individually, and the text between two
  // comments must survive.
  it('drops two comments individually without eating the text between them', () => {
    const { xhtml, warnings } = render('<!-- toc -->General index<!-- /toc -->\n');
    expect(xhtml).toContain('General index');
    expect(xhtml).not.toContain('toc');
    // The leftover text after stripping the comments is plain prose, not unsafe raw HTML;
    // warning about it as if it were escaped-because-unsafe raw HTML would be misleading.
    expect(warnings).toEqual([]);
  });

  it('still warns when a comment-bearing node also carries a genuinely unsafe tag', () => {
    const { warnings } = render('<!-- note --><div onclick="x">dangerous</div>\n');
    expect(warnings.some((w) => w.includes('HTML'))).toBe(true);
  });

  // A comment whose body contains "-->" inside a quoted string is mis-tokenised by micromark —
  // the comment ends at the first "-->", leaving a residue with no "<" in it at all.
  it('escapes the residue of a mis-tokenised comment without warning about it', () => {
    const { xhtml, warnings } = render('<!-- x = "a --> b" -->Text after\n');
    expect(xhtml).toBe(' b&quot; --&gt;Text after');
    expect(warnings).toEqual([]);
  });

  // `includes('<')` warned "raw HTML was escaped" about prose that merely contains a "<".
  // The guard is a tag-like test now: a "<" followed by whitespace or a digit begins no tag.
  it.each([
    ['<!-- note -->5 < 10 is true\n', '5 &lt; 10 is true'],
    ['<!-- note -->a < b\n', 'a &lt; b'],
  ])('does not warn about prose containing a bare "<" (%j)', (markdown, expected) => {
    const { xhtml, warnings } = render(markdown);
    expect(xhtml).toBe(expected);
    expect(warnings).toEqual([]);
  });

  // The other direction, which must not regress: genuinely tag-like raw HTML still warns, and
  // the warning still names the source file and the offending text.
  it.each(['<div class="x">\n', '</span>\n'])('still warns about genuinely unsafe raw HTML (%j)', (markdown) => {
    const { warnings } = render(markdown);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('docs/a.md');
    expect(warnings[0]).toContain('raw HTML was escaped');
    expect(warnings[0]).toContain(markdown.trim());
  });

  it('produces an empty body for an empty document without throwing', () => {
    expect(render('').xhtml).toBe('');
  });

  it('passes through bare br and hr tags unchanged', () => {
    const { xhtml } = render('line one<br>line two\n\n<hr/>\n\n<hr>\n');
    expect(xhtml).toContain('line one<br/>line two');
    expect(xhtml).toContain('<hr/>');
  });

  it('escapes a br tag carrying an attribute and warns', () => {
    const { xhtml, warnings } = render('line<br class="x">wrapped\n');
    expect(xhtml).toContain('&lt;br class=&quot;x&quot;&gt;');
    expect(xhtml).not.toContain('<br class="x">');
    expect(warnings.some((w) => w.includes('HTML'))).toBe(true);
  });

  it('re-emits an img tag keeping only whitelisted attributes, with values escaped', () => {
    const { xhtml } = render('<img src="a&b.jpg" alt="x">\n');
    expect(xhtml).toContain('src="a&amp;b.jpg"');
    expect(xhtml).toContain('alt="x"');
    expect(xhtml).toMatch(/<img[^>]*\/>/);
  });

  // micromark does not decode character references inside `html` nodes (raw HTML is copied
  // verbatim from source), unlike text nodes. An author-typed "&amp;" in a raw img attribute
  // must survive as "&amp;", not become "&amp;amp;" under an unconditional escape.
  it('does not double-escape an already-valid entity inside a raw img attribute value', () => {
    const { xhtml } = render('<img src="a.png?x=1&amp;y=2" alt="x">\n');
    expect(xhtml).toContain('src="a.png?x=1&amp;y=2"');
    expect(xhtml).not.toContain('&amp;amp;');
  });

  // The earlier lookahead exempted ANY `&name;` shape, not only the five XML-defined entities
  // (amp/lt/gt/quot/apos) plus numeric references. Confluence storage format is XHTML, which
  // does not define `&nbsp;` (an HTML-only entity): shipping it verbatim produces a fragment
  // that does not parse as XML, and Confluence rejects the whole page body. `&nbsp;` inside a
  // hand-written `<img alt>` is ordinary Markdown, not an exotic case.
  it('escapes a non-XML entity-like sequence inside a raw img attribute instead of shipping invalid XML', () => {
    const { xhtml } = render('<img src="a.png" alt="Foo&nbsp;Bar">\n');
    expect(xhtml).toContain('alt="Foo&amp;nbsp;Bar"');
    expect(xhtml).not.toContain('alt="Foo&nbsp;Bar"');
  });

  it('still leaves the five XML-defined entities and numeric references untouched in a raw attribute', () => {
    const { xhtml } = render('<img src="a.png" alt="A &amp; B &lt;x&gt; &quot;q&quot; &apos;a&apos; &#38; &#x26;">\n');
    expect(xhtml).toContain('alt="A &amp; B &lt;x&gt; &quot;q&quot; &apos;a&apos; &#38; &#x26;"');
  });

  // Numeric character references were validated syntactically (`#\d+;` / `#x[0-9A-Fa-f]+;`)
  // without checking whether the code point denoted is one XML 1.0 actually permits
  // (Char ::= #x9 | #xA | #xD | #x20-#xD7FF | #xE000-#xFFFD | #x10000-#x10FFFF). An
  // out-of-range or surrogate reference shipped verbatim and Confluence rejected the whole page
  // on ingest. Invalid references now degrade to literal text (their `&` is escaped) instead of
  // shipping raw; no warning is emitted, since the document is no longer corrupted and nothing
  // is dropped.
  // Cases, in array order: a null code point / a control code point below tab / the last control
  // code point below the printable lower bound, hex then decimal (kills the lower-bound mutant) /
  // a high surrogate / a low surrogate / the two non-characters just above the 0xFFFD BMP
  // ceiling (kills the upper-bound mutant) / a code point past the Unicode ceiling / a wildly
  // out-of-range decimal reference.
  describe.each(['&#0;', '&#x8;', '&#x1F;', '&#31;', '&#xD800;', '&#xDFFF;', '&#xFFFE;', '&#xFFFF;', '&#x110000;', '&#99999999;'])(
    'an invalid numeric character reference (%s)',
    (reference) => {
      it('is escaped to literal text instead of shipped as a raw reference', () => {
        const { xhtml, warnings } = render(`<img src="a.png" alt="x${reference}y">\n`);
        expect(xhtml).toContain(`alt="x&amp;${reference.slice(1)}y"`);
        expect(xhtml).not.toContain(`alt="x${reference}y"`);
        expect(warnings).toEqual([]);
      });
    },
  );

  // Cases, in array order: tab / line feed / the carriage return, hex then decimal — permitted
  // by the Char production even though it sits below the printable lower bound (deleting the
  // `codePoint === 0xd` clause is what these two kill) / space, the lower bound of the main
  // range / a plain accented letter / the first private-use code point after the surrogate gap /
  // the replacement character, upper bound of that range / the first supplementary-plane code
  // point / the last valid Unicode code point.
  describe.each(['&#9;', '&#xA;', '&#xD;', '&#13;', '&#x20;', '&#233;', '&#xE000;', '&#xFFFD;', '&#x10000;', '&#x10FFFF;'])(
    'a valid numeric character reference (%s)',
    (reference) => {
      it('passes through unchanged', () => {
        const { xhtml } = render(`<img src="a.png" alt="x${reference}y">\n`);
        expect(xhtml).toContain(`alt="x${reference}y"`);
      });
    },
  );

  it('escapes an img tag carrying a non-whitelisted attribute and warns', () => {
    const { xhtml, warnings } = render('text <img src="x" onerror="alert(1)"> more\n');
    expect(xhtml).not.toContain('<img src="x" onerror="alert(1)">');
    expect(xhtml).toContain('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;');
    expect(warnings.some((w) => w.includes('HTML'))).toBe(true);
  });

  it('escapes a literal angle bracket inside a whitelisted img attribute value', () => {
    const { xhtml } = render('text <img src="x" alt="1 < 2"> more\n');
    expect(xhtml).toContain('alt="1 &lt; 2"');
  });

  it('falls back to escaping the whole tag when an img attribute uses single quotes', () => {
    const { xhtml, warnings } = render(`text <img src="x" alt='she said "hi"'> more\n`);
    expect(xhtml).toContain('&lt;img');
    expect(xhtml).toContain('&quot;hi&quot;');
    expect(warnings.some((w) => w.includes('HTML'))).toBe(true);
  });
});

// Numeric character references naming an illegal code point were guarded, but a *literal*
// illegal character was guarded nowhere. `escapeXml` passes everything but `& < > "` through,
// `escapeRawAttributeValue` inspects only `&#…;` shapes, and CDATA has no escape mechanism at
// all, so a control character inside a fenced block shipped verbatim and Confluence rejected
// the whole page body on parse. `toStorage` now strips them from the assembled document.
describe('literal code points XML 1.0 forbids', () => {
  const ch = (codePoint: number): string => String.fromCodePoint(codePoint);

  it('removes a literal control character from a paragraph and warns once, naming the source', () => {
    const { xhtml, warnings } = render(`before${ch(0x01)}after\n`);
    expect(xhtml).toBe('<p>beforeafter</p>');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('docs/a.md');
    expect(warnings[0]).toContain('removed 1 code point(s)');
  });

  // A literal U+0000 never reaches the serialiser: CommonMark requires the parser to replace it
  // with U+FFFD during preprocessing, and micromark does so for every construct, CDATA included.
  // The rendered body is therefore free of U+0000 whatever the source contained — but by
  // substitution upstream, not by removal here, so this document raises no warning.
  it('never emits U+0000, which micromark has already replaced with U+FFFD', () => {
    const { xhtml, warnings } = render(`before${ch(0x00)}after\n`);
    expect(xhtml).not.toContain(ch(0x00));
    expect(xhtml).toBe(`<p>before${ch(0xfffd)}after</p>`);
    expect(warnings).toEqual([]);
  });

  // The Char production's edges, asserted on both sides through the renderer's own entry point.
  // Every one of them, U+000D included, survives parsing as a literal and reaches the serialiser
  // from ordinary Markdown source.
  describe.each([
    ['0008', 0x08, false], ['0009', 0x09, true], ['000A', 0x0a, true], ['000B', 0x0b, false],
    ['000C', 0x0c, false], ['000D', 0x0d, true], ['001F', 0x1f, false], ['0020', 0x20, true],
    ['FFFD', 0xfffd, true], ['FFFE', 0xfffe, false], ['FFFF', 0xffff, false],
  ])('U+%s', (_label, codePoint, kept) => {
    it(kept ? 'survives' : 'is removed', () => {
      const { xhtml, warnings } = render(`a${ch(codePoint)}b\n`);
      expect(xhtml).toBe(kept ? `<p>a${ch(codePoint)}b</p>` : '<p>ab</p>');
      expect(warnings).toHaveLength(kept ? 0 : 1);
    });
  });

  it('removes a lone surrogate but keeps a correctly paired astral character', () => {
    const lone = render(`lone ${String.fromCharCode(0xd800)} here\n`);
    expect(lone.xhtml).toBe('<p>lone  here</p>');
    expect(lone.warnings).toHaveLength(1);

    const paired = render('emoji \u{1F600} here\n');
    expect(paired.xhtml).toBe('<p>emoji \u{1F600} here</p>');
    expect([...paired.xhtml].filter((c) => c.codePointAt(0) === 0x1f600)).toHaveLength(1);
    expect(paired.warnings).toEqual([]);
  });

  it('removes an illegal literal from inside a fenced code block, which CDATA cannot escape', () => {
    const { xhtml, warnings } = render(`\`\`\`\nco${ch(0x07)}de\n\`\`\`\n`);
    expect(xhtml).toContain('<![CDATA[code]]>');
    expect(xhtml).not.toContain(ch(0x07));
    expect(warnings).toHaveLength(1);
  });

  it('removes an illegal literal from inside a raw-HTML attribute value', () => {
    const { xhtml, warnings } = render(`<img src="a.png" alt="x${ch(0x0b)}y">\n`);
    expect(xhtml).toContain('alt="xy"');
    expect(xhtml).not.toContain(ch(0x0b));
    expect(warnings).toHaveLength(1);
  });

  it('emits one warning carrying the total count, however many paragraphs are affected', () => {
    const { xhtml, warnings } = render(
      `a${ch(0x01)}b${ch(0x02)}c\n\nd${ch(0x1f)}e\n\nf${ch(0xffff)}g\n`,
    );
    expect(xhtml).toBe('<p>abc</p><p>de</p><p>fg</p>');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('removed 4 code point(s)');
  });

  it('leaves a document with none of them byte-identical and warning-free', () => {
    const { xhtml, warnings } = render('Ordinary text with é, \u{1F600} and a tab-free line.\n');
    expect(xhtml).toBe('<p>Ordinary text with é, \u{1F600} and a tab-free line.</p>');
    expect(warnings).toEqual([]);
  });
});
