import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolError } from "./errors.js";

export const KEY_MISSING = "Set VOCALSTACK_API_KEY to an API key from https://app.vocalstack.com (Developers → API keys).";
export const KEY_REFUSED =
  "The API key was refused. Check that VOCALSTACK_API_KEY holds a current API key from https://app.vocalstack.com (Developers → API keys).";
export const TOP_UP_URL = "https://app.vocalstack.com/billing";

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) o[k] = sorted((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

export function toolOk(v: Record<string, unknown>): CallToolResult {
  const body = sorted(v) as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body };
}

export function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function toolError(e: ToolError): CallToolResult {
  const status = e.status;
  const details = e.details ?? {};
  const retryAfter = details.retryAfterS ?? null;
  const topUp = details.topUpUrl ?? (status === 402 ? TOP_UP_URL : null);
  let guidance = "";
  if (status === 402 && e.code === "insufficient_credit") {
    guidance =
      " The account has not enough credit to start this (a new transcription needs more than its minimum charge costs); add credit before trying again.";
  } else if (status === 402 && e.code === "usage_cap_reached") {
    guidance =
      typeof details.resetsAt === "string"
        ? ` This API key reached the usage cap its account set for it; it resets at ${details.resetsAt}, or the account can raise the cap. Adding credit does not lift it.`
        : " This API key reached the usage cap its account set for it; the account can raise the cap. Adding credit does not lift it.";
  } else if (status === 402) {
    guidance = typeof details.resetsAt === "string" ? ` The quota resets at ${details.resetsAt}.` : "";
  } else if (status === 429) {
    guidance = ` Wait ${typeof retryAfter === "number" && retryAfter >= 0 ? Math.floor(retryAfter) : 5} seconds before trying again.`;
  } else if (status === 503) {
    guidance = " Try again shortly.";
  }
  const message = status === 401 ? KEY_REFUSED : status === 500 ? "Something went wrong on the server." : e.message;
  const body = sorted({
    error: e.code,
    status,
    message,
    retryable: status === 429 || status === 503 || e.retryable,
    retryAfterS: retryAfter,
    topUpUrl: topUp,
    details,
  }) as Record<string, unknown>;
  const stop = guidance === "" || /[.!?]$/.test(message) ? "" : ".";
  return { content: [{ type: "text", text: `${message}${stop}${guidance}` }], structuredContent: body, isError: true };
}
