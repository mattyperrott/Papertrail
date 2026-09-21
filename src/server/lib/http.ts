const DEFAULT_TIMEOUT_MS = 12_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new Error('Request cancelled')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

export interface HttpClientOptions {
  fetch?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  minRequestIntervalMs?: number;
  random?: () => number;
}

export function createHttpClient(options: HttpClientOptions = {}) {
  const cooldown = new Map<string, number>();
  const nextStart = new Map<string, number>();
  const retries = options.maxRetries ?? 2;
  const interval = options.minRequestIntervalMs ?? 50;

  async function fetchText(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('HTTP timeout must be positive and finite');
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Invalid upstream URL');
    }
    const host = target.host;
    const safeMethod = ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    if (!headers.has('User-Agent')) headers.set('User-Agent', 'Papertrail/0.1 (+paper-trading research)');
    if (!headers.has('Accept')) headers.set('Accept', 'application/json,text/html;q=0.9,*/*;q=0.8');
    try {
      for (let attempt = 0; ; attempt++) {
        const startAt = Math.max(Date.now(), nextStart.get(host) ?? 0, cooldown.get(host) ?? 0);
        nextStart.set(host, startAt + interval);
        if (startAt > Date.now()) await sleep(startAt - Date.now(), signal);
        // A concurrent request may have learned Retry-After while this request waited.
        while ((cooldown.get(host) ?? 0) > Date.now()) await sleep(cooldown.get(host)! - Date.now(), signal);
        if (signal.aborted) throw new Error('Request cancelled');
        let response: Response;
        try {
          response = await (options.fetch ?? globalThis.fetch)(url, {
            ...init, signal, headers,
            // Custom API-key headers must never follow an untrusted redirect.
            redirect: 'error',
          });
        } catch {
          if (signal.aborted) throw new Error('Request cancelled');
          if (!safeMethod || attempt >= retries) throw new Error(`Network request failed from ${target.hostname}`);
          await sleep(backoff(attempt), signal);
          continue;
        }
        if (response.ok) {
          // The body is part of the deadline, including slow or stalled responses.
          try { return await response.text(); }
          catch { throw new Error(`Response body failed from ${target.hostname}`); }
        }
        await response.body?.cancel().catch(() => undefined);
        const retryAfter = response.headers.get('retry-after');
        const retrySeconds = retryAfter?.trim() ? Number(retryAfter) : Number.NaN;
        const retryDelay = Number.isFinite(retrySeconds)
          ? Math.max(0, retrySeconds * 1000)
          : Math.max(0, Date.parse(retryAfter ?? '') - Date.now());
        const delay = Number.isFinite(retryDelay) ? Math.max(backoff(attempt), retryDelay) : backoff(attempt);
        if (response.status === 429 || response.status === 503) cooldown.set(host, Date.now() + Math.min(delay, 300_000));
        if (!safeMethod || attempt >= retries || !RETRYABLE_STATUSES.has(response.status)) {
          throw new Error(`HTTP ${response.status} from ${target.hostname}`);
        }
        await sleep(delay, signal);
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Request timed out from ${target.hostname}`);
      if (init.signal?.aborted) throw new Error(`Request cancelled from ${target.hostname}`);
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function backoff(attempt: number) {
    return Math.min(3000, (options.baseDelayMs ?? 250) * 2 ** attempt) * (0.5 + (options.random ?? Math.random)() * 0.5);
  }

  async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const body = await fetchText(url, init, timeoutMs);
    try { return JSON.parse(body) as T; }
    catch { throw new Error(`Invalid JSON from ${new URL(url).hostname}`); }
  }

  return { fetchText, fetchJson };
}

const client = createHttpClient();
export const fetchText = client.fetchText;
export const fetchJson = client.fetchJson;

export function numberFrom(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !value.trim()) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function stringFrom(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
