import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

/**
 * The plan's global constraints require source code, comments and identifiers to be English;
 * Italian belongs in user-facing documentation only.
 *
 * This is a marker list, not a language detector: it catches Italian function words and elided
 * articles that no English sentence produces. It guarantees that these specific markers never
 * reappear in `src/`; it does NOT guarantee that any given Italian sentence is caught — a comment
 * built only from words outside the list passes. Treat a green run as "no known marker", never as
 * "this file is English".
 */
const ITALIAN_MARKERS: readonly RegExp[] = [
  /\bgi[àa]\b/i,
  /\bperch[ée]\b/i,
  /\bper[òo]\b/i,
  /\b(della|delle|degli|dello|dalla|dallo|dalle|nella|nelle|nello|sulla|sullo|sulle)\b/i,
  /\b(questo|questa|questi|queste|quello|quella|quelli|quelle)\b/i,
  /\b(viene|vengono|sono|essere|senza|soltanto|oppure|inoltre|quindi|quando|anche)\b/i,
  /\b(unica|unico|eccezione|attenzione)\b/i,
  /\b(restituisce|numero|pagine|allegati|caricati|pubblicate|relativi)\b/i,
  // An elided article is an apostrophe *inside* a word, so a letter must follow it. A closing
  // single quote never is: in TypeScript it is always followed by a delimiter (`|`, `;`, `,`,
  // `)`, whitespace…), which is why `'all' | 'current'` and `'view all';` are not Italian.
  // The trailing letter class is the whole distinction — do not "simplify" it away.
  /\b(dell|all|nell|sull|dall|un)'[a-zà-öø-ÿ]/i,
];

/** The first marker matching `line`, or undefined. Exposed so both directions can be pinned. */
function italianMarkerIn(line: string): RegExp | undefined {
  return ITALIAN_MARKERS.find((marker) => marker.test(line));
}

async function typeScriptSources(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) out.push(...(await typeScriptSources(path)));
    else if (item.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('source language', () => {
  it('keeps every file under src/ free of Italian prose', async () => {
    const files = await typeScriptSources(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (italianMarkerIn(line) !== undefined) {
          offenders.push(`${file.slice(SRC_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  // A scanner that reddens the build on a union of English string literals would be worse than
  // no scanner at all, so the quoted-literal shapes are pinned explicitly.
  it('accepts ordinary TypeScript that quotes English words in single quotes', () => {
    const lines = [
      "export type StatusFilter = 'all' | 'current';",
      "const mode = flag ? 'all' : 'un';",
      "if (key === 'dell' || key === 'nell') return null;",
      "await client.request('GET', '/wiki/api/v2/pages', { query: { status: 'all' } });",
      // The marker word ends the literal here, so the apostrophe is a closing quote that no
      // opening quote immediately precedes: only the trailing-letter rule can tell this apart.
      "const label = 'view all';",
      "const suffix = 'nothing to un';",
      '// Reads all properties for the page, one page of results at a time.',
    ];
    for (const line of lines) expect(italianMarkerIn(line)).toBeUndefined();
  });

  it('still flags Italian elided articles in prose', () => {
    expect(italianMarkerIn("// il valore passa all'oggetto")).toBeDefined();
    expect(italianMarkerIn("// definito nell'ambito del modulo")).toBeDefined();
    expect(italianMarkerIn("// scritto dall'autore")).toBeDefined();
  });

  // This sentence once slipped past the marker list; the list was widened to cover it and this
  // pins the widening. Does not turn the scanner into a detector — see the note on
  // ITALIAN_MARKERS above.
  it('flags the Italian comment the round-2 review injected', () => {
    expect(
      italianMarkerIn('// Restituisce il numero di pagine pubblicate e i relativi allegati caricati.'),
    ).toBeDefined();
  });

  it('flags the two comments C1 removed, verbatim', () => {
    expect(
      italianMarkerIn("  /** Property già lette dallo scan dell'indice, indicizzate per pageId; assente nei test. */"),
    ).toBeDefined();
    expect(
      italianMarkerIn(" * ATTENZIONE — unica eccezione documentata all'uso esclusivo dell'API v2 (spec R9, §5)."),
    ).toBeDefined();
  });
});
