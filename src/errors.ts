export type Details = Record<string, unknown>;

const STATUS: Record<string, number> = {
  invalid_audio: 400,
  invalid_options: 400,
  invalid_token: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  idempotency_key_reused: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
  timeout: 504,
};

const RETRYABLE = new Set([
  "capacity_exceeded",
  "engine_unavailable",
  "engine_lost",
  "rate_limited",
  "preview_pending",
  "timeout",
  "unavailable",
]);

export class ToolError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    readonly details: Details = {},
    status?: number,
    retryable?: boolean,
  ) {
    super(message);
    this.status = status ?? STATUS[code] ?? 400;
    this.retryable = retryable ?? RETRYABLE.has(code);
  }
}

export function bad(message: string): ToolError {
  return new ToolError("invalid_options", message);
}
