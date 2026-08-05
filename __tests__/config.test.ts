import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

const valid = {
  folder: 'docs/',
  'base-url': 'https://acme.atlassian.net/',
  username: 'user@acme.com',
  'api-token': 'token',
  'space-key': 'DOC',
  'parent-page-id': '123456',
  include: '**/*.md',
  exclude: '',
  'title-strategy': 'h1',
  'dry-run': 'false',
  'fail-on-error': 'true',
  orphans: 'report',
  concurrency: '4',
  'request-timeout-ms': '30000',
  'max-retries': '5',
  'version-message': 'Updated by GitHub Actions',
  'add-source-footer': 'true',
  'mermaid-macro': 'code',
};

describe('parseConfig', () => {
  it('normalises folder and base-url by stripping trailing slashes', () => {
    const cfg = parseConfig(valid);
    expect(cfg.folder).toBe('docs');
    expect(cfg.baseUrl).toBe('https://acme.atlassian.net');
  });

  it('splits multi-line globs and drops blank lines', () => {
    const cfg = parseConfig({ ...valid, exclude: 'plans/**\n\n  superpowers/**  \n' });
    expect(cfg.exclude).toEqual(['plans/**', 'superpowers/**']);
  });

  it('defaults include to **/*.md when empty', () => {
    expect(parseConfig({ ...valid, include: '' }).include).toEqual(['**/*.md']);
  });

  it('rejects a missing required input naming it', () => {
    expect(() => parseConfig({ ...valid, 'space-key': '  ' })).toThrow(/space-key/);
  });

  it('rejects an unknown title-strategy listing the admissible values', () => {
    expect(() => parseConfig({ ...valid, 'title-strategy': 'slug' })).toThrow(
      /title-strategy.*h1.*filename.*frontmatter/s,
    );
  });

  it('rejects a non-numeric concurrency', () => {
    expect(() => parseConfig({ ...valid, concurrency: 'many' })).toThrow(ConfigError);
  });

  it('rejects a concurrency below 1', () => {
    expect(() => parseConfig({ ...valid, concurrency: '0' })).toThrow(/concurrency/);
  });

  it('rejects a base-url that is not http(s)', () => {
    expect(() => parseConfig({ ...valid, 'base-url': 'ftp://acme' })).toThrow(/base-url/);
  });

  it('rejects an absolute folder path', () => {
    expect(() => parseConfig({ ...valid, folder: '/etc' })).toThrow(/folder/);
  });

  it('rejects a folder path that escapes the repository with ..', () => {
    expect(() => parseConfig({ ...valid, folder: '../etc' })).toThrow(/folder/);
  });

  it('rejects "/" as a folder, instead of silently normalising it to the repo root', () => {
    // The trailing-slash strip used to run before the absolute-path guard, so "/" became ""
    // and startsWith('/') was false by the time the guard ran, bypassing it entirely.
    expect(() => parseConfig({ ...valid, folder: '/' })).toThrow(/folder/);
  });

  it('normalises a leading "./" so that "./docs" and "docs" mean the same folder', () => {
    // Folder normalisation only stripped trailing slashes, so "./docs" was kept as a distinct
    // (and wrong) prefix, producing a spurious extra container level when matched against
    // repo-relative source paths such as "docs/a.md".
    expect(parseConfig({ ...valid, folder: './docs' }).folder).toBe('docs');
    expect(parseConfig({ ...valid, folder: './docs' }).folder).toBe(
      parseConfig({ ...valid, folder: 'docs' }).folder,
    );
  });

  it('rejects "." and "./" as a folder, since both normalise to the empty (repository-root) path', () => {
    // The `folder === ''` rejection after normaliseFolderPath is what makes "." and "./"
    // (as opposed to "/", covered above) invalid rather than silently meaning "publish from
    // the repository root".
    expect(() => parseConfig({ ...valid, folder: '.' })).toThrow(/folder/);
    expect(() => parseConfig({ ...valid, folder: './' })).toThrow(/folder/);
  });

  it('parses booleans case-insensitively', () => {
    expect(parseConfig({ ...valid, 'dry-run': 'TRUE' }).dryRun).toBe(true);
  });

  it('rejects a boolean that is neither true nor false', () => {
    expect(() => parseConfig({ ...valid, 'dry-run': 'yes' })).toThrow(/dry-run/);
  });
});

describe('ConfigError', () => {
  // An Error subclass with an empty body inherits name === 'Error', so anything formatting
  // the error by name loses which failure surface it came from.
  it('reports its own class name', () => {
    expect(new ConfigError('x').name).toBe('ConfigError');
  });

  it('keeps the message it was constructed with', () => {
    expect(new ConfigError('x').message).toBe('x');
  });

  it('is still an Error', () => {
    expect(new ConfigError('x') instanceof Error).toBe(true);
  });
});
