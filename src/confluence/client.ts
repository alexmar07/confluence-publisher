// `BodyInit` is not exposed as a global type by @types/node's fetch declarations,
// only `RequestInit['body']` is (typed as `BodyInit | null`); alias it locally.
type BodyInit = NonNullable<RequestInit['body']>;

export interface ClientOptions {
  baseUrl: string;
  username: string;
  apiToken: string;
  requestTimeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; status: number | null; url: string }) => void;
  onRequest?: (info: { method: string; url: string; status: number | null }) => void;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  expectNoContent?: boolean;
}

export class ConfluenceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly url: string,
  ) {
    super(`${method} ${url} failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'ConfluenceHttpError';
  }
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    // Four characters is a deliberate floor, not an oversight. A 1–3 character "secret" carries
    // no meaningful secrecy, while replacing its every occurrence would shred ordinary
    // error-body prose into `***` soup and destroy the log's diagnostic value.
    if (secret.length < 4) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Exponential backoff with full jitter, capped at 30 s. */
function backoffDelay(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

export class ConfluenceClient {
  readonly baseUrl: string;
  readonly authorizationHeader: string;
  private readonly secrets: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authorizationHeader = `Basic ${Buffer.from(`${options.username}:${options.apiToken}`).toString('base64')}`;
    this.secrets = [options.apiToken, options.username, this.authorizationHeader];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private buildUrl(path: string, query: RequestOptions['query']): string {
    const url = path.startsWith('http') ? new URL(path) : new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const safeUrl = redact(url, this.secrets);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      try {
        const headers: Record<string, string> = {
          authorization: this.authorizationHeader,
          accept: 'application/json',
          ...options.headers,
        };
        let body: BodyInit | undefined = options.rawBody;
        if (body === undefined && options.body !== undefined) {
          body = JSON.stringify(options.body);
          headers['content-type'] = 'application/json';
        }

        const response = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
        this.options.onRequest?.({ method, url: safeUrl, status: response.status });

        if (response.ok) {
          if (options.expectNoContent || response.status === 204) return undefined as T;
          const text = await response.text();
          return (text === '' ? undefined : JSON.parse(text)) as T;
        }

        const text = redact(await response.text(), this.secrets);
        const error = new ConfluenceHttpError(response.status, text, method, safeUrl);
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === this.options.maxRetries) throw error;

        const delay = parseRetryAfter(response.headers.get('retry-after'), Date.now()) ?? backoffDelay(attempt);
        this.options.onRetry?.({ attempt: attempt + 1, delayMs: delay, status: response.status, url: safeUrl });
        await this.sleep(delay);
        lastError = error;
      } catch (error) {
        if (error instanceof ConfluenceHttpError) {
          if (!RETRYABLE_STATUSES.has(error.status) || attempt === this.options.maxRetries) throw error;
          lastError = error;
        } else {
          if (attempt === this.options.maxRetries) throw error;
          const delay = backoffDelay(attempt);
          this.options.onRetry?.({ attempt: attempt + 1, delayMs: delay, status: null, url: safeUrl });
          await this.sleep(delay);
          lastError = error;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Request ${method} ${safeUrl} failed.`);
  }

  /** Yields every element of `results`, following `_links.next` until it is absent. */
  async *paginate<T>(path: string, query?: RequestOptions['query']): AsyncGenerator<T, void, undefined> {
    let next: string | null = this.buildUrl(path, query);
    while (next !== null) {
      const page: { results?: T[]; _links?: { next?: string } } = await this.request('GET', next);
      for (const item of page.results ?? []) yield item;
      const link: string | undefined = page._links?.next;
      next = link === undefined || link === '' ? null : link.startsWith('http') ? link : `${this.baseUrl}${link}`;
    }
  }
}
