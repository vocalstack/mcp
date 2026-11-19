import { createHash } from "node:crypto";
import type { Api } from "./api.js";
import type { Args } from "./args.js";
import { ToolError, bad } from "./errors.js";

type Json = Record<string, any>;

export interface Context {
  api: Api;
  signal: AbortSignal;
  progress?: (progress: number, total: number, message: string) => Promise<void>;
}

export type Handler = (a: Args, ctx: Context) => Promise<Json>;

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BASE64_CHARS = Math.floor(MAX_FILE_BYTES / 3) * 4 + 8 + 1024;
const WAIT_MAX_S = 60;
const WAIT_DEFAULT_S = 50;
const WAIT_POLL_MS = 1000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
const NO_TRANSCRIPTION = "No transcription with that id for this account.";
const NO_BROADCAST = "No broadcast with that id for this account.";
const OPEN = new Set(["pending", "live", "paused", "processing"]);
const TERMINAL = new Set(["done", "failed", "stopped"]);

function put(o: Json, k: string, v: unknown): void {
  if (v !== undefined && v !== null) o[k] = v;
}

function path(...parts: string[]): string {
  return parts.map((p, i) => (i % 2 ? encodeURIComponent(p) : p)).join("");
}

function notFound(e: unknown, message: string): never {
  if (e instanceof ToolError && (e.code === "not_found" || e.code === "forbidden")) {
    throw new ToolError("not_found", message);
  }
  throw e;
}

async function transcription(ctx: Context, id: string): Promise<Json> {
  try {
    return await ctx.api.get(path("/v1/transcriptions/", id), undefined, ctx.signal);
  } catch (e) {
    notFound(e, NO_TRANSCRIPTION);
  }
}

async function broadcast(ctx: Context, id: string): Promise<Json> {
  try {
    return await ctx.api.get(path("/v1/broadcasts/", id), undefined, ctx.signal);
  } catch (e) {
    notFound(e, NO_BROADCAST);
  }
}

function jobStatus(job: Json, t: Json): Json {
  const pr = job.progress ?? {};
  const progress: Json = { pct: pr.pct ?? 0, processedS: pr.processedS ?? 0, segmentsDone: pr.segmentsDone ?? 0 };
  put(progress, "totalS", pr.totalS);
  put(progress, "segmentsTotal", pr.segmentsTotal);
  put(progress, "phase", pr.phase);
  put(progress, "phasePct", pr.phasePct);
  const s: Json = { transcriptionId: t.id, name: t.name, kind: "file", state: job.state, progress, createdAt: job.createdAt };
  put(s, "error", job.error);
  put(s, "queue", job.queue);
  put(s, "finishedAt", job.finishedAt);
  put(s, "spokenLanguage", t.spokenLanguage);
  if (job.source) {
    const o: Json = { kind: job.source.kind, name: job.source.name };
    put(o, "durationS", job.source.durationS);
    put(o, "format", job.source.format);
    s.source = o;
  }
  return s;
}

function liveState(state: string): string {
  switch (state) {
    case "processing":
    case "ended":
      return "finishing";
    case "finalized":
      return "done";
    default:
      return state;
  }
}

function liveStatus(t: Json): Json {
  const s: Json = { transcriptionId: t.id, name: t.name, kind: "live", state: liveState(t.state), createdAt: t.createdAt };
  put(s, "startedAt", t.startedAt);
  put(s, "endedAt", t.endedAt);
  put(s, "spokenLanguage", t.spokenLanguage);
  put(s, "durationS", t.durationS);
  return s;
}

function statusOf(t: Json): Json {
  return t.job ? jobStatus(t.job, t) : liveStatus(t);
}

function mmss(s: number): string {
  const t = Math.floor(Math.max(0, s));
  const two = (n: number) => String(n).padStart(2, "0");
  if (t >= 3600) return `${Math.floor(t / 3600)}:${two(Math.floor(t / 60) % 60)}:${two(t % 60)}`;
  return `${two(Math.floor(t / 60))}:${two(t % 60)}`;
}

function genericName(n: string): boolean {
  const w = n.trim().split(/\s+/);
  return w.length === 2 && w[0].toLowerCase() === "speaker" && /^\d*$/.test(w[1]);
}

interface Line {
  start: number;
  end: number;
  speaker: number;
  speakerName: string;
  text: string;
  language?: string | null;
  words?: Json[];
}

function firstOrder(lines: { speaker: number; start: number }[]): Map<number, number> {
  const first = new Map<number, number>();
  for (const l of lines) {
    if (l.speaker < 0) continue;
    const at = first.get(l.speaker);
    if (at === undefined || l.start < at) first.set(l.speaker, l.start);
  }
  const order = [...first.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return new Map(order.map(([spk], i) => [spk, i + 1]));
}

function labelled(raw: Omit<Line, "speakerName">[], snapshot: Json, t: Json): Line[] {
  const mode: string = snapshot.speakerLabels ?? t.settings?.speakerLabels ?? "auto";
  const off = mode === "off";
  const lines = raw.map((l) => ({ ...l, speaker: off ? -1 : l.speaker }));
  const heard = new Set(raw.map((l) => l.speaker).filter((s) => s >= 0)).size;
  const shown = mode === "on" || (mode === "auto" && heard > 1);
  const names = new Map<number, string>();
  const server = new Map<number, number>();
  for (const a of snapshot.speakers ?? []) {
    if (typeof a.name === "string") names.set(a.speaker, a.name);
    if (typeof a.number === "number") server.set(a.speaker, a.number);
  }
  const order = firstOrder(lines);
  const numbers = new Map(server);
  if (server.size === 0) for (const [k, v] of order) numbers.set(k, v);
  else {
    let top = Math.max(...server.values());
    const rest = [...order.entries()].filter(([s]) => !server.has(s)).sort((a, b) => a[1] - b[1]);
    for (const [s] of rest) numbers.set(s, ++top);
  }
  return lines.map((l) => {
    let speakerName = "";
    if (shown) {
      if (l.speaker < 0) speakerName = "Unknown speaker";
      else {
        const given = names.get(l.speaker)?.trim();
        speakerName = given && !genericName(given) ? given : `Speaker ${numbers.get(l.speaker) ?? 0}`;
      }
    }
    return { ...l, speakerName };
  });
}

function page(lines: Line[], format: string, words: boolean, offset: number, limit: number): Json {
  const total = lines.length;
  const slice = lines.slice(Math.min(offset, total), Math.min(offset + limit, total));
  const out: Json = { segmentCount: total };
  if (offset + slice.length < total) out.nextOffset = offset + slice.length;
  const numbers = firstOrder(lines);
  const speaker = (l: Line): string | undefined => {
    if (l.speakerName.trim()) return l.speakerName;
    if (l.speaker >= 0) return `Speaker ${numbers.get(l.speaker) ?? l.speaker + 1}`;
    return undefined;
  };
  if (format === "segments") {
    out.segments = slice.map((l) => {
      const s: Json = { start: l.start, end: l.end, text: l.text };
      if (l.speaker >= 0) s.speaker = l.speaker;
      put(s, "speakerName", speaker(l));
      put(s, "language", l.language);
      if (words) s.words = (l.words ?? []).map((w) => ({ text: w.text, start: w.start, end: w.end }));
      return s;
    });
  } else {
    out.text = slice
      .map((l) => {
        const n = speaker(l);
        return n ? `[${mmss(l.start)}] ${n}: ${l.text.trim()}` : `[${mmss(l.start)}] ${l.text.trim()}`;
      })
      .join("\n");
  }
  return out;
}

async function snapshot(ctx: Context, id: string): Promise<Json> {
  try {
    return await ctx.api.get(path("/v1/transcriptions/", id, "/transcript"), undefined, ctx.signal);
  } catch (e) {
    notFound(e, NO_TRANSCRIPTION);
  }
}

function segmentLines(snap: Json, t: Json): Line[] {
  const raw = (snap.segments ?? [])
    .filter((s: Json) => typeof s.text === "string" && s.text.trim())
    .map((s: Json) => ({ start: s.start, end: s.end, speaker: s.speaker ?? -1, text: s.text, language: s.language, words: s.words ?? [] }));
  return labelled(raw, snap, t);
}

function validKey(k: string): boolean {
  return k.length >= 1 && k.length <= 255 && /^[\x21-\x7e]+$/.test(k);
}

function idempotencyKey(a: Args): string | undefined {
  const k = a.str("idempotencyKey");
  if (k !== undefined && !validKey(k)) throw bad("idempotencyKey must be 1 to 255 visible ASCII characters");
  return k;
}

function stepKey(key: string, step: string): string {
  const k = `${key}:${step}`;
  return k.length <= 255 ? k : `${createHash("sha256").update(key).digest("hex")}:${step}`;
}

function transcribeOptions(a: Args): Json {
  const settings: Json = {};
  const spoken = a.str("spokenLanguage");
  if (spoken !== undefined) settings.spokenLanguage = spoken;
  settings.speakerLabels = a.oneOf("speakerLabels", ["auto", "on", "off"], "auto");
  if (a.bool("summary")) {
    settings.summary = true;
    settings.title = true;
  }
  const options: Json = { settings, shareLink: a.bool("shareLink") };
  put(options, "name", a.str("name"));
  put(options, "startS", a.num("startS"));
  put(options, "endS", a.num("endS"));
  return options;
}

function decodeFile(a: Args): Buffer {
  const tooBig = () => bad(`fileBase64 is over ${MAX_FILE_BYTES >> 20} MiB decoded; give transcribe_url a link to the file instead`);
  const raw = a.rawStr("fileBase64");
  if (raw === undefined) throw bad("`fileBase64` must be a string");
  if (raw.length > MAX_FILE_BASE64_CHARS) throw tooBig();
  let b64 = raw.trim();
  const at = b64.indexOf(";base64,");
  if (at >= 0) b64 = b64.slice(at + 8);
  if (!b64) throw bad("`fileBase64` is required");
  if (b64.length > Math.floor(MAX_FILE_BYTES / 3) * 4 + 8) throw tooBig();
  const clean = b64.replace(/\s+/g, "");
  const body = clean.replace(/=+$/, "");
  const badAt = body.search(/[^A-Za-z0-9+/]/);
  if (badAt >= 0) throw bad(`fileBase64 is not valid base64: Invalid symbol ${body.charCodeAt(badAt)}, offset ${badAt}.`);
  if (body.length % 4 === 1 || clean.length - body.length > 2) throw bad("fileBase64 is not valid base64: Invalid input length.");
  const bytes = Buffer.from(body, "base64");
  if (bytes.length > MAX_FILE_BYTES) throw bad(`the file is over ${MAX_FILE_BYTES >> 20} MiB; give transcribe_url a link to it instead`);
  if (bytes.length === 0) throw new ToolError("invalid_audio", "the file is empty");
  return bytes;
}

async function transcribe(a: Args, ctx: Context, file: boolean): Promise<Json> {
  const key = idempotencyKey(a);
  const options = transcribeOptions(a);
  let res;
  if (!file) {
    const url = a.reqStr("url");
    if (url.length > 2048) throw bad("`url` is longer than 2048 characters");
    res = await ctx.api.request("POST", "/v1/transcriptions", { json: { ...options, url }, idempotencyKey: key, signal: ctx.signal });
  } else {
    const filename = a.reqStr("filename");
    const bytes = decodeFile(a);
    const mime = a.str("mimeType");
    const type = mime && mime !== "application/octet-stream" ? mime : "application/octet-stream";
    const form = new FormData();
    form.append("options", JSON.stringify(options));
    form.append("file", new Blob([new Uint8Array(bytes)], { type }), [...filename].slice(0, 255).join(""));
    res = await ctx.api.request("POST", "/v1/transcriptions", { form, idempotencyKey: key, signal: ctx.signal, timeoutMs: UPLOAD_TIMEOUT_MS });
  }
  const t: Json = res.data;
  if (!t.job) t.job = await ctx.api.get(path("/v1/transcriptions/", t.id, "/job"), undefined, ctx.signal);
  const v = statusOf(t);
  if (options.shareLink) {
    const links = await ctx.api.get(path("/v1/transcriptions/", t.id, "/share-links"), undefined, ctx.signal);
    const first = links?.links?.[0];
    if (first?.url) v.shareUrl = first.url;
  }
  v.next = "Call wait_for_transcription with this transcriptionId.";
  if (res.headers.get("idempotent-replayed") === "true") v.replayed = true;
  return v;
}

async function getTranscription(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  const format = a.oneOf("format", ["text", "segments", "none"], "text");
  const words = a.bool("includeWords");
  const offset = a.int("offset", 0, 0, 4294967295);
  const limit = a.int("limit", 500, 1, 2000);
  const t = await transcription(ctx, id);
  const out: Json = { status: statusOf(t) };
  if (format === "none") return out;
  const snap = await snapshot(ctx, id);
  Object.assign(out, page(segmentLines(snap, t), format, words, offset, limit));
  const partial = t.job ? !TERMINAL.has(t.job.state) : t.state !== "finalized";
  if (partial) out.partial = true;
  return out;
}

function phaseText(job: Json): string {
  const pr = job.progress ?? {};
  if (job.state === "fetching") {
    const b = pr.fetchedBytes;
    const t = pr.fetchTotalBytes;
    if (pr.phase === "extracting") return "extracting the audio";
    if (typeof b === "number" && typeof t === "number") return `fetching ${(b / 1e6).toFixed(1)} / ${(t / 1e6).toFixed(1)} MB`;
    if (typeof b === "number") return `fetching ${(b / 1e6).toFixed(1)} MB`;
    return "fetching";
  }
  if (job.state === "transcribing") {
    const done = pr.processedS ?? 0;
    return typeof pr.totalS === "number" ? `transcribing ${mmss(done)} of ${mmss(pr.totalS)}` : `transcribing ${mmss(done)}`;
  }
  return String(job.state);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function wait(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  const timeoutMs = a.int("timeoutS", WAIT_DEFAULT_S, 1, WAIT_MAX_S) * 1000;
  const t = await transcription(ctx, id);
  let st = statusOf(t);
  let job = t.job;
  if (!job || TERMINAL.has(job.state)) return { ...st, timedOut: false };
  const deadline = Date.now() + timeoutMs;
  let lastSent: string | undefined;
  let lastAt = 0;
  for (;;) {
    if (ctx.progress) {
      const msg = phaseText(job);
      const now = `${job.progress?.pct ?? 0}|${msg}`;
      if (lastSent !== now && Date.now() - lastAt >= 1000) {
        await ctx.progress(job.progress?.pct ?? 0, 100, msg).catch(() => {});
        lastSent = now;
        lastAt = Date.now();
      }
    }
    const left = deadline - Date.now();
    if (left <= 0 || ctx.signal.aborted) return { ...st, timedOut: true };
    await sleep(Math.min(WAIT_POLL_MS, left), ctx.signal);
    if (ctx.signal.aborted) return { ...st, timedOut: true };
    try {
      job = await ctx.api.get(path("/v1/transcriptions/", id, "/job"), undefined, ctx.signal);
    } catch (e) {
      if (ctx.signal.aborted) return { ...st, timedOut: true };
      notFound(e, NO_TRANSCRIPTION);
    }
    st = jobStatus(job, t);
    if (TERMINAL.has(job.state)) return { ...st, timedOut: false };
  }
}

async function listTranscriptions(a: Args, ctx: Context): Promise<Json> {
  const lifecycle = a.oneOf("lifecycle", ["active", "archived", "all"], "active");
  const limit = a.int("limit", 20, 1, 100);
  let cursor = a.str("cursor");
  const items: Json[] = [];
  for (let i = 0; i < 10; i++) {
    let got: Json;
    try {
      got = await ctx.api.get("/v1/transcriptions", { lifecycle, cursor, limit: limit - items.length }, ctx.signal);
    } catch (e) {
      if (e instanceof ToolError && e.code === "invalid_options") throw bad("`cursor` is not one this tool gave out");
      throw e;
    }
    for (const s of got.transcriptions ?? []) {
      const v: Json = { transcriptionId: s.id, name: s.name, createdAt: s.createdAt };
      if (s.job) {
        v.kind = "file";
        v.state = s.job.state;
        put(v, "durationS", s.job.source?.durationS ?? s.job.progress?.totalS);
      } else {
        v.kind = "live";
        v.state = liveState(s.state);
        put(v, "durationS", s.durationS);
        put(v, "broadcastId", s.broadcasts?.[0]?.id);
      }
      put(v, "title", s.title);
      items.push(v);
    }
    cursor = got.nextCursor ?? undefined;
    if (!cursor || items.length >= limit) break;
  }
  const out: Json = { transcriptions: items };
  if (cursor) out.nextCursor = cursor;
  return out;
}

function query(a: Args): string {
  const q = a.reqStr("query");
  const n = [...q].length;
  if (n < 2 || n > 200) throw bad("`query` must be 2 to 200 characters");
  return q;
}

async function only(a: Args, ctx: Context): Promise<string | undefined> {
  const id = a.optId("transcriptionId");
  if (id !== undefined) await transcription(ctx, id);
  return id;
}

async function search(a: Args, ctx: Context): Promise<Json> {
  const q = query(a);
  const transcriptionId = await only(a, ctx);
  const lang = a.str("lang");
  const limit = a.int("limit", 20, 1, 50);
  const r = await ctx.api.get("/v1/search", { q, transcription: transcriptionId, lang, limit }, ctx.signal);
  const hits = (r.hits ?? []).map((h: Json) => {
    const v: Json = {
      transcriptionId: h.transcriptionId,
      name: h.linkName,
      mediaStart: h.mediaStart,
      speaker: h.speaker,
      text: h.text,
      score: h.score,
      live: h.live,
    };
    put(v, "rendered", h.rendered);
    put(v, "recordedAt", h.recordedAt);
    return v;
  });
  return { query: r.query, queryEn: r.queryEn, hits };
}

async function searchByMeaning(a: Args, ctx: Context): Promise<Json> {
  const q = query(a);
  const transcriptionId = await only(a, ctx);
  const r = await ctx.api.get("/v1/search/vector", { q, transcription: transcriptionId }, ctx.signal);
  const passages = (r.hits ?? []).map((h: Json) => ({
    transcriptionId: h.transcriptionId,
    name: h.linkName,
    mediaStart: h.passage?.mediaStart ?? h.mediaStart,
    mediaEnd: h.passage?.mediaEnd ?? h.mediaStart,
    text: h.passage?.text ?? h.text,
    similarity: Math.round(h.similarity * 1000) / 1000,
    live: h.live,
  }));
  const out: Json = { query: r.query, state: r.state, passages };
  put(out, "searchesLeftThisHour", r.allowance?.remaining);
  return out;
}

function family(l: string): string {
  return l.split(/[_-]/)[0].toLowerCase();
}

async function summary(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  const lang = a.str("lang")?.toLowerCase();
  const t = await transcription(ctx, id);
  const pending = (message: string) => ({ state: "pending", message });
  const s = await ctx.api.get(path("/v1/transcriptions/", id, "/summary"), { lang }, ctx.signal);
  if (s.state === "ready") {
    const v: Json = { state: "ready", title: s.title ?? t.name, summary: s.summary };
    put(v, "lang", s.lang);
    return v;
  }
  if (t.job?.state === "failed") {
    return { state: "unavailable", message: "The transcription failed, so there is nothing to summarise." };
  }
  if ((t.job && !TERMINAL.has(t.job.state)) || (!t.job && OPEN.has(t.state))) {
    return pending("The transcription is still running; wait for it (wait_for_transcription), then ask again.");
  }
  if (s.state === "pending") return pending("The summary is being written; ask again in a few seconds.");
  let made: Json;
  try {
    made = (await ctx.api.request("POST", path("/v1/transcriptions/", id, "/summarize"), { signal: ctx.signal })).data;
  } catch (e) {
    if (e instanceof ToolError && e.code === "forbidden") {
      throw new ToolError(
        "forbidden",
        "This transcription has no summary yet, and starting one needs the write scope; this credential can only read an existing summary.",
        { requiredScope: ["write"] },
      );
    }
    throw e;
  }
  switch (made.state) {
    case "ready":
      return { state: "ready", title: made.title ?? t.name, summary: made.summary };
    case "unavailable":
      return { state: "unavailable", message: "Summaries are not available on this server." };
    case "not_requested":
      return { state: "not_requested", message: "Transcriptions shorter than a minute are not summarised." };
    default:
      return pending("The summary is being written; ask again in a few seconds.");
  }
}

async function translate(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  const lang = a.reqStr("lang").toLowerCase();
  const format = a.oneOf("format", ["text", "segments"], "text");
  const offset = a.int("offset", 0, 0, 4294967295);
  const limit = a.int("limit", 500, 1, 2000);
  const t = await transcription(ctx, id);
  if (t.job && t.job.state !== "done") {
    throw new ToolError("invalid_state", `the transcription is ${t.job.state}; wait until it is done (wait_for_transcription)`);
  }
  if (!t.job && OPEN.has(t.state)) {
    throw new ToolError(
      "invalid_state",
      "the live transcription is still running; read the text so far with get_transcription, or stop it (stop_broadcast) and translate it then",
    );
  }
  const snap = await snapshot(ctx, id);
  const spoken: string | undefined = t.spokenLanguage ?? undefined;
  const same = spoken !== undefined && family(spoken) === family(lang);
  if (same) {
    return { ...page(segmentLines(snap, t), format, false, offset, limit), lang, translated: false };
  }
  const sentences: Json[] = (snap.sentences ?? [])
    .filter((s: Json) => s.status !== "dropped" && typeof s.text === "string" && s.text.trim())
    .sort((x: Json, y: Json) => x.start - y.start || x.sentenceId - y.sentenceId);
  const lines = labelled(
    sentences.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker ?? -1, text: s.text, language: s.language })),
    snap,
    t,
  );
  const shown = sentences.slice(Math.min(offset, sentences.length), Math.min(offset + limit, sentences.length));
  const have = new Map<number, string>();
  const missing: number[] = [];
  for (const s of shown) {
    const done = s.translations?.[lang];
    if (typeof done === "string") have.set(s.sentenceId, done);
    else if (!(s.language && family(s.language) === family(lang))) missing.push(s.sentenceId);
  }
  for (let i = 0; i < missing.length; i += 40) {
    let r: Json;
    try {
      r = await ctx.api.get(path("/v1/transcriptions/", id, "/translation"), { lang, sentences: missing.slice(i, i + 40).join(",") }, ctx.signal);
    } catch (e) {
      if (e instanceof ToolError && e.code === "invalid_options") throw bad(`\`lang\` ${JSON.stringify(lang)} is not a language this API translates into`);
      notFound(e, NO_TRANSCRIPTION);
    }
    for (const [k, v] of Object.entries(r.translations ?? {})) if (typeof v === "string") have.set(Number(k), v);
  }
  sentences.forEach((s, i) => {
    const done = have.get(s.sentenceId);
    if (done !== undefined) {
      lines[i].text = done;
      lines[i].language = lang;
    } else if (!(s.language && family(s.language) === family(lang))) {
      lines[i].language = s.language ?? spoken ?? null;
    }
  });
  return { ...page(lines, format, false, offset, limit), lang, translated: true };
}

async function voices(a: Args, ctx: Context): Promise<Json> {
  const lang = a.reqStr("lang");
  const cat = await ctx.api.get("/v1/voices/available", { lang }, ctx.signal);
  const list = (cat.voices ?? []).map((v: Json) => {
    const o: Json = { id: v.id, name: v.name, default: v.default, cloned: v.cloned, quality: v.quality };
    put(o, "gender", v.gender);
    put(o, "accent", v.accent);
    if (typeof v.previewUrl === "string") o.previewUrl = v.previewUrl.startsWith("/") ? ctx.api.origin + v.previewUrl : v.previewUrl;
    return o;
  });
  return { lang: cat.lang, voices: list };
}

async function all(ctx: Context, route: string, field: string, query: Json = {}): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.api.get(route, { ...query, cursor }, ctx.signal);
    out.push(...(r[field] ?? []));
    cursor = r.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

async function speakers(_a: Args, ctx: Context): Promise<Json> {
  const list = await all(ctx, "/v1/speakers", "speakers");
  return {
    speakers: list.map((s) => {
      const o: Json = { id: s.id, name: s.name, cloned: s.voice != null };
      if (s.voice) o.voiceReady = s.voice.state === "ready" && s.voice.enabled === true && s.consent === "granted";
      put(o, "gender", s.gender);
      return o;
    }),
  };
}

function onAir(b: Json): Json | undefined {
  const c = b.currentTranscription;
  return c && ["live", "paused", "pending"].includes(c.state) ? c : undefined;
}

function brief(b: Json): Json {
  const c = onAir(b);
  const v: Json = {
    broadcastId: b.id,
    name: b.name,
    link: b.shareUrl,
    access: b.access,
    onAir: c !== undefined,
    listenersNow: b.listenersNow ?? 0,
  };
  if (b.lifecycle && b.lifecycle !== "active") v.archived = true;
  if (c) {
    v.transcriptionId = c.transcriptionId;
    v.state = liveState(c.state);
    put(v, "onAirSince", c.startedAt);
  }
  put(v, "lastRecordedAt", b.lastRecordedAt);
  return v;
}

async function listBroadcasts(a: Args, ctx: Context): Promise<Json> {
  const lifecycle = a.oneOf("lifecycle", ["active", "archived", "all"], "active");
  const list = await all(ctx, "/v1/broadcasts", "broadcasts", { lifecycle });
  return { broadcasts: list.map(brief) };
}

async function getBroadcast(a: Args, ctx: Context): Promise<Json> {
  const b = await broadcast(ctx, a.id("broadcastId"));
  const v = brief(b);
  v.transcriptions = (b.transcriptions ?? []).slice(0, 20).map((t: Json) => {
    const o: Json = { transcriptionId: t.id, name: t.name, recording: t.recording };
    put(o, "lastRecordedAt", t.lastRecordedAt);
    return o;
  });
  v.streams = (b.audioSources ?? []).map((s: Json) => ({ name: s.name, url: s.url }));
  return v;
}

function streamUrl(a: Args): string {
  const u = a.reqStr("streamUrl");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw bad("`streamUrl` must be an http(s) address");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw bad("`streamUrl` must be an http(s) address");
  return u;
}

const ON_AIR = "This broadcast is already on air; stop it first (stop_broadcast) or use another broadcast.";

async function startBroadcast(a: Args, ctx: Context): Promise<Json> {
  const key = idempotencyKey(a);
  const url = streamUrl(a);
  const spoken = a.str("spokenLanguage")?.toLowerCase();
  const speak = a.bool("spokenTranslations");
  let b: Json;
  const given = a.optId("broadcastId");
  if (given !== undefined) {
    b = await broadcast(ctx, given);
  } else {
    let name = a.str("name");
    if (name === undefined) {
      try {
        name = new URL(url).hostname.replace(/^www\./, "") || "Live stream";
      } catch {
        name = "Live stream";
      }
    }
    const made = await ctx.api.request("POST", "/v1/broadcasts", {
      json: { name },
      idempotencyKey: key && stepKey(key, "broadcast"),
      signal: ctx.signal,
    });
    b = made.data;
    if (made.headers.get("idempotent-replayed") === "true") b = await broadcast(ctx, b.id);
  }
  const settings: Json = {};
  if (spoken !== undefined) settings.spokenLanguage = spoken;
  if (speak) settings.translationTts = true;
  const record = async (source: string) =>
    ctx.api.request("POST", path("/v1/broadcasts/", b.id, "/record"), {
      json: Object.keys(settings).length ? { audioSource: source, settings } : { audioSource: source },
      idempotencyKey: key && stepKey(key, "record"),
      signal: ctx.signal,
    });
  const refuse = () => new ToolError("invalid_state", ON_AIR, { broadcastId: b.id, link: b.shareUrl });
  let grant;
  if (onAir(b)) {
    const source = (b.audioSources ?? []).find((s: Json) => s.url === url)?.id;
    if (!key || !source) throw refuse();
    try {
      grant = await record(source);
    } catch {
      throw refuse();
    }
    if (grant.headers.get("idempotent-replayed") !== "true") throw refuse();
  } else {
    if (!(b.audioSources ?? []).some((s: Json) => s.url === url)) {
      b = (await ctx.api.request("POST", path("/v1/broadcasts/", b.id, "/audio-sources"), { json: { url }, signal: ctx.signal })).data;
    }
    const source = (b.audioSources ?? []).find((s: Json) => s.url === url)?.id;
    if (!source) throw new ToolError("internal", "the stream was not added");
    grant = await record(source);
  }
  const v: Json = {
    broadcastId: b.id,
    name: b.name,
    link: b.shareUrl,
    transcriptionId: grant.data.transcription?.id,
    state: liveState(grant.data.transcription?.state),
    message:
      "Share the link: anyone who opens it picks a language and reads (or hears) the stream in it as it plays. Read the transcript with get_transcription; stop it with stop_broadcast.",
  };
  if (grant.headers.get("idempotent-replayed") === "true") v.replayed = true;
  return v;
}

async function stopBroadcast(a: Args, ctx: Context): Promise<Json> {
  const b = await broadcast(ctx, a.id("broadcastId"));
  const c = onAir(b);
  if (!c) throw new ToolError("invalid_state", "This broadcast is not on air.", { broadcastId: b.id });
  const tid: string = c.transcriptionId;
  const t = await transcription(ctx, tid);
  if (t.state === "live") await ctx.api.request("POST", path("/v1/transcriptions/", tid, "/pause"), { signal: ctx.signal });
  if (OPEN.has(t.state)) await ctx.api.request("POST", path("/v1/transcriptions/", tid, "/stop"), { json: {}, signal: ctx.signal });
  const after = await transcription(ctx, tid);
  return { ...liveStatus(after), broadcastId: b.id, link: b.shareUrl };
}

export const handlers: Record<string, Handler> = {
  transcribe_url: (a, ctx) => transcribe(a, ctx, false),
  transcribe_file: (a, ctx) => transcribe(a, ctx, true),
  get_transcription: getTranscription,
  wait_for_transcription: wait,
  list_transcriptions: listTranscriptions,
  search_transcriptions: search,
  search_by_meaning: searchByMeaning,
  get_summary: summary,
  translate_transcription: translate,
  list_voices: voices,
  list_speakers: speakers,
  list_broadcasts: listBroadcasts,
  get_broadcast: getBroadcast,
  start_broadcast: startBroadcast,
  stop_broadcast: stopBroadcast,
};
