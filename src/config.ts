export type TitleStrategy = 'h1' | 'filename' | 'frontmatter';
export type OrphanPolicy = 'report' | 'ignore';

export interface Config {
  folder: string;
  baseUrl: string;
  username: string;
  apiToken: string;
  spaceKey: string;
  parentPageId: string;
  include: string[];
  exclude: string[];
  titleStrategy: TitleStrategy;
  dryRun: boolean;
  failOnError: boolean;
  orphans: OrphanPolicy;
  concurrency: number;
  requestTimeoutMs: number;
  maxRetries: number;
  versionMessage: string;
  addSourceFooter: boolean;
  mermaidMacro: string;
}

export class ConfigError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Collapses a repo-relative path into canonical segment form. A ".." segment is deliberately
 * preserved rather than collapsed away, so that a caller validating for path traversal (see
 * `parseConfig` below) still sees it.
 *
 * Shared with `buildTree` in `tree.ts` so that "./docs" and "docs" are indistinguishable by the
 * time either module acts on them.
 */
export function normaliseFolderPath(raw: string): string {
  return raw
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

type Raw = Readonly<Record<string, string>>;

function required(raw: Raw, name: string): string {
  const value = (raw[name] ?? '').trim();
  if (value === '') throw new ConfigError(`Input "${name}" is required and must not be empty.`);
  return value;
}

function optional(raw: Raw, name: string, fallback: string): string {
  const value = (raw[name] ?? '').trim();
  return value === '' ? fallback : value;
}

function bool(raw: Raw, name: string, fallback: boolean): boolean {
  const value = (raw[name] ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigError(`Input "${name}" must be "true" or "false", got "${raw[name] ?? ''}".`);
}

function integer(raw: Raw, name: string, fallback: number, min: number): number {
  const value = (raw[name] ?? '').trim();
  if (value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigError(`Input "${name}" must be an integer, got "${value}".`);
  const parsed = Number.parseInt(value, 10);
  if (parsed < min) throw new ConfigError(`Input "${name}" must be >= ${min}, got ${parsed}.`);
  return parsed;
}

// Exported so `__tests__/index-wiring.test.ts` can derive action.yml's declared defaults through
// the very function parseConfig applies to them, instead of hand-copying its body.
export function lines(raw: Raw, name: string, fallback: string[]): string[] {
  const value = raw[name] ?? '';
  const parsed = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return parsed.length === 0 ? fallback : parsed;
}

function oneOf<T extends string>(raw: Raw, name: string, allowed: readonly T[], fallback: T): T {
  const value = optional(raw, name, fallback);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`Input "${name}" must be one of ${allowed.join(' | ')}, got "${value}".`);
  }
  return value as T;
}

export function parseConfig(raw: Raw): Config {
  // The absolute-path guard must run on the raw input, before normalisation. Stripping trailing
  // slashes first turns "/" into "" (an empty string does not start with "/"), letting an
  // absolute folder path bypass the guard entirely.
  const rawFolder = required(raw, 'folder');
  if (rawFolder.startsWith('/')) {
    throw new ConfigError(`Input "folder" must be a relative path inside the repository, got "${rawFolder}".`);
  }
  const folder = normaliseFolderPath(rawFolder);
  if (folder === '' || folder.split('/').includes('..')) {
    throw new ConfigError(`Input "folder" must be a relative path inside the repository, got "${rawFolder}".`);
  }

  // Every request path in `src/confluence/` is written as "/wiki/...", so the base URL must be the
  // site root. A user who pastes the URL they see in the browser ("https://x.atlassian.net/wiki")
  // would otherwise produce "/wiki/wiki/api/v2/..." — a path Confluence answers with its SPA shell
  // and a bare HTTP 404, which reads as "space not found" rather than "base-url is wrong".
  const baseUrl = required(raw, 'base-url')
    .replace(/\/+$/, '')
    .replace(/\/wiki$/i, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new ConfigError(`Input "base-url" must start with http:// or https://, got "${baseUrl}".`);
  }

  return {
    folder,
    baseUrl,
    username: required(raw, 'username'),
    apiToken: required(raw, 'api-token'),
    spaceKey: required(raw, 'space-key'),
    parentPageId: required(raw, 'parent-page-id'),
    include: lines(raw, 'include', ['**/*.md']),
    exclude: lines(raw, 'exclude', []),
    titleStrategy: oneOf(raw, 'title-strategy', ['h1', 'filename', 'frontmatter'] as const, 'h1'),
    dryRun: bool(raw, 'dry-run', false),
    failOnError: bool(raw, 'fail-on-error', true),
    orphans: oneOf(raw, 'orphans', ['report', 'ignore'] as const, 'report'),
    concurrency: integer(raw, 'concurrency', 4, 1),
    requestTimeoutMs: integer(raw, 'request-timeout-ms', 30_000, 1_000),
    maxRetries: integer(raw, 'max-retries', 5, 0),
    versionMessage: optional(raw, 'version-message', 'Updated by GitHub Actions'),
    addSourceFooter: bool(raw, 'add-source-footer', true),
    mermaidMacro: optional(raw, 'mermaid-macro', 'code'),
  };
}
