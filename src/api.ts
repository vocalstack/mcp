import { ToolError, type Details } from "./errors.js";

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  json?: unknown;
  form?: FormData;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Response<T> {
  data: T;
  headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function linked(outer: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
    timedOut: () => expired,
  };
}

function fallbackCode(status: number): string {
  if (status === 401) return "invalid_token";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 504) return "timeout";
  if (status >= 500) return status === 500 ? "internal" : "unavailable";
  return "invalid_options";
}

export class Api {
  readonly origin: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly userAgent: string,
  ) {
    this.origin = baseUrl.replace(/\/+$/, "");
  }

  url(path: string, query?: Query): string {
    const u = new URL(this.origin + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<Response<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "user-agent": this.userAgent,
      accept: "application/json",
    };
    let body: string | FormData | undefined;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    const t = linked(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: globalThis.Response;
    let text: string;
    try {
      res = await fetch(this.url(path, opts.query), { method, headers, body, signal: t.signal });
      text = await res.text();
    } catch (error) {
      if (t.timedOut()) throw new ToolError("timeout", "VocalStack did not answer in time; try again.");
      if (opts.signal?.aborted) throw new ToolError("timeout", "The call was cancelled.");
      const why = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new ToolError("unavailable", `Could not reach VocalStack (${why}).`);
    } finally {
      t.done();
    }
    let parsed: any = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const code = typeof parsed?.code === "string" ? parsed.code : fallbackCode(res.status);
      const message = typeof parsed?.message === "string" && parsed.message ? parsed.message : `VocalStack answered HTTP ${res.status}.`;
      const details: Details = parsed?.data?.details && typeof parsed.data.details === "object" ? parsed.data.details : {};
      const retryable = typeof parsed?.data?.retryable === "boolean" ? parsed.data.retryable : undefined;
      throw new ToolError(code, message, details, res.status, retryable);
    }
    return { data: parsed as T, headers: res.headers };
  }

  get<T = any>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, { query, signal }).then((r) => r.data);
  }
}
