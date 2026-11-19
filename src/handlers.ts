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
export const WAIT_MAX_S = 60;
export const WAITS_PER_KEY = 4;
const WAIT_POLL_MS = 1000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
const LANGUAGES_TTL_MS = 60 * 60_000;
const NO_TRANSCRIPTION = "No transcription with that id for this account.";
const NO_BROADCAST = "No broadcast with that id for this account.";
const NO_SPEAKER = "No saved speaker with that id for this account; list_speakers shows them.";
const OPEN = new Set(["pending", "live", "paused", "processing"]);
const TERMINAL = new Set(["done", "failed", "stopped"]);

function put(o: Json, k: string, v: unknown): void {
  if (v !== undefined && v !== null) o[k] = v;
}

function path(...parts: string[]): string {
  return parts.map((p, i) => (i % 2 ? encodeURIComponent(p) : p)).join("");
}

function present(a: Args, k: string): boolean {
  return a.raw[k] !== undefined && a.raw[k] !== null;
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

const languages = new Map<string, { at: number; codes: Set<string> }>();

async function targetLang(a: Args, ctx: Context, k: string): Promise<string | undefined> {
  const l = a.str(k)?.toLowerCase();
  if (l === undefined) return undefined;
  let known = languages.get(ctx.api.origin);
  if (!known || Date.now() - known.at > LANGUAGES_TTL_MS) {
    try {
      const r = await ctx.api.get("/v1/languages", undefined, ctx.signal);
      if (Array.isArray(r?.translation) && r.translation.length) {
        known = { at: Date.now(), codes: new Set(r.translation.map((c: unknown) => String(c).toLowerCase())) };
        languages.set(ctx.api.origin, known);
      }
    } catch {
      known = undefined;
    }
  }
  if (known && !known.codes.has(l)) throw bad(`\`${k}\` ${JSON.stringify(l)} is not a language this API translates into`);
  return l;
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
  speakerNumber?: number;
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

function numbering(lines: { speaker: number; start: number }[], snapshot: Json): Map<number, number> {
  const server = new Map<number, number>();
  for (const a of snapshot.speakers ?? []) {
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
  return numbers;
}

function labelled(raw: Omit<Line, "speakerName">[], snapshot: Json, t: Json): Line[] {
  const mode: string = snapshot.speakerLabels ?? t.settings?.speakerLabels ?? "auto";
  const off = mode === "off";
  const lines = raw.map((l) => ({ ...l, speaker: off ? -1 : l.speaker }));
  const heard = new Set(raw.map((l) => l.speaker).filter((s) => s >= 0)).size;
  const shown = mode === "on" || (mode === "auto" && heard > 1);
  const names = new Map<number, string>();
  for (const a of snapshot.speakers ?? []) {
    if (typeof a.name === "string") names.set(a.speaker, a.name);
  }
  const numbers = numbering(lines, snapshot);
  return lines.map((l) => {
    let speakerName = "";
    if (shown) {
      if (l.speaker < 0) speakerName = "Unknown speaker";
      else {
        const given = names.get(l.speaker)?.trim();
        speakerName = given && !genericName(given) ? given : `Speaker ${numbers.get(l.speaker) ?? 0}`;
      }
    }
    const speakerNumber = l.speaker >= 0 ? numbers.get(l.speaker) : undefined;
    return { ...l, speakerName, speakerNumber };
  });
}

function page(lines: Line[], format: string, words: boolean, offset: number, limit: number): Json {
  const total = lines.length;
  const slice = lines.slice(Math.min(offset, total), Math.min(offset + limit, total));
  const out: Json = { segmentCount: total };
  if (offset + slice.length < total) out.nextOffset = offset + slice.length;
  const speaker = (l: Line): string | undefined => {
    if (l.speakerName.trim()) return l.speakerName;
    if (l.speaker >= 0) return `Speaker ${l.speakerNumber ?? l.speaker + 1}`;
    return undefined;
  };
  if (format === "segments") {
    out.segments = slice.map((l) => {
      const s: Json = { start: l.start, end: l.end, text: l.text };
      if (l.speaker >= 0) {
        s.speaker = l.speaker;
        put(s, "speakerNumber", l.speakerNumber);
      }
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

function spokenSegments(snap: Json): Omit<Line, "speakerName">[] {
  return (snap.segments ?? [])
    .filter((s: Json) => typeof s.text === "string" && s.text.trim())
    .map((s: Json) => ({ start: s.start, end: s.end, speaker: s.speaker ?? -1, text: s.text, language: s.language, words: s.words ?? [] }));
}

function segmentLines(snap: Json, t: Json): Line[] {
  return labelled(spokenSegments(snap), snap, t);
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

function sourceOf(a: Args): boolean {
  const url = present(a, "url");
  const file = present(a, "fileBase64");
  if (url && file) throw bad("give either `url` or `fileBase64`, not both");
  if (!url && !file) throw bad(`give \`url\` (a public link) or \`fileBase64\` with \`filename\` (a file up to ${MAX_FILE_BYTES >> 20} MiB)`);
  if (url) {
    const stray = ["filename", "mimeType"].find((k) => present(a, k));
    if (stray) throw bad(`\`${stray}\` goes with \`fileBase64\`, not with \`url\``);
  }
  return file;
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
  const tooBig = () => bad(`fileBase64 is over ${MAX_FILE_BYTES >> 20} MiB decoded; give \`url\` a link to the file instead`);
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
  if (bytes.length > MAX_FILE_BYTES) throw bad(`the file is over ${MAX_FILE_BYTES >> 20} MiB; give \`url\` a link to it instead`);
  if (bytes.length === 0) throw new ToolError("invalid_audio", "the file is empty");
  return bytes;
}

async function createTranscription(a: Args, ctx: Context): Promise<Json> {
  const key = idempotencyKey(a);
  const file = sourceOf(a);
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
  v.next = `Call get_transcription with this transcriptionId and waitS (up to ${WAIT_MAX_S}) to wait for the text.`;
  if (res.headers.get("idempotent-replayed") === "true") v.replayed = true;
  return v;
}

let waitsOpen = 0;

function takeWait(): () => void {
  if (waitsOpen >= WAITS_PER_KEY) {
    throw new ToolError("rate_limited", `this key already has ${WAITS_PER_KEY} waits open; let one finish first`, {
      retryAfterS: 5,
      limit: WAITS_PER_KEY,
    });
  }
  waitsOpen++;
  let held = true;
  return () => {
    if (held) waitsOpen--;
    held = false;
  };
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

async function waitFor(ctx: Context, id: string, first: Json, timeoutMs: number): Promise<boolean> {
  const release = takeWait();
  try {
    const deadline = Date.now() + timeoutMs;
    let job = first;
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
      if (left <= 0 || ctx.signal.aborted) return true;
      await sleep(Math.min(WAIT_POLL_MS, left), ctx.signal);
      if (ctx.signal.aborted) return true;
      try {
        job = await ctx.api.get(path("/v1/transcriptions/", id, "/job"), undefined, ctx.signal);
      } catch (e) {
        if (ctx.signal.aborted) return true;
        notFound(e, NO_TRANSCRIPTION);
      }
      if (TERMINAL.has(job.state)) return false;
    }
  } finally {
    release();
  }
}

function family(l: string): string {
  return l.split(/[_-]/)[0].toLowerCase();
}

async function translatedLines(ctx: Context, id: string, snap: Json, t: Json, lang: string, offset: number, limit: number): Promise<Line[]> {
  const spoken: string | undefined = t.spokenLanguage ?? undefined;
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
  return lines;
}

async function getTranscription(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  const waitS = a.int("waitS", 0, 0, WAIT_MAX_S);
  const format = a.oneOf("format", ["text", "segments", "summary", "none"], "text");
  const lang = await targetLang(a, ctx, "lang");
  const words = a.bool("includeWords");
  if (words && lang !== undefined) throw bad("`includeWords` is for the original language; leave it out with `lang`");
  const offset = a.int("offset", 0, 0, 4294967295);
  const limit = a.int("limit", 500, 1, 2000);
  let t = await transcription(ctx, id);
  let timedOut: boolean | undefined;
  if (waitS > 0) {
    timedOut = false;
    if (t.job && !TERMINAL.has(t.job.state)) {
      timedOut = await waitFor(ctx, id, t.job, waitS * 1000);
      t = await transcription(ctx, id);
    }
  }
  const status = statusOf(t);
  try {
    const links = await ctx.api.get(path("/v1/transcriptions/", id, "/share-links"), undefined, ctx.signal);
    const first = links?.links?.[0];
    if (first?.url) status.shareUrl = first.url;
  } catch {}
  const out: Json = { status };
  if (timedOut !== undefined) out.timedOut = timedOut;
  if (format === "none") return out;
  if (format === "summary") {
    if (words) throw bad("`includeWords` goes with format segments");
    out.summary = await summaryOf(ctx, id, t, lang);
    return out;
  }
  if (lang !== undefined) {
    let notYet: string | undefined;
    if (t.job && t.job.state !== "done") notYet = `the transcription is ${t.job.state}; wait until it is done (get_transcription with waitS)`;
    else if (!t.job && OPEN.has(t.state)) {
      notYet = "the live transcription is still running; read the text so far without lang, or stop it (stop_broadcast) and translate it then";
    }
    if (notYet !== undefined) {
      if (timedOut === true) return out;
      throw new ToolError("invalid_state", notYet);
    }
    const snap = await snapshot(ctx, id);
    const spoken: string | undefined = t.spokenLanguage ?? undefined;
    const same = spoken !== undefined && family(spoken) === family(lang);
    const lines = same ? segmentLines(snap, t) : await translatedLines(ctx, id, snap, t, lang, offset, limit);
    return { ...out, ...page(lines, format, false, offset, limit), lang, translated: !same };
  }
  const snap = await snapshot(ctx, id);
  Object.assign(out, page(segmentLines(snap, t), format, words, offset, limit));
  const partial = t.job ? !TERMINAL.has(t.job.state) : t.state !== "finalized";
  if (partial) out.partial = true;
  return out;
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

async function searchWords(a: Args, ctx: Context): Promise<Json> {
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

async function searchMeaning(a: Args, ctx: Context): Promise<Json> {
  const stray = ["lang", "limit"].find((k) => present(a, k));
  if (stray) throw bad(`\`${stray}\` applies to mode words only; leave it out with mode meaning`);
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

async function search(a: Args, ctx: Context): Promise<Json> {
  return a.oneOf("mode", ["words", "meaning"], "words") === "meaning" ? searchMeaning(a, ctx) : searchWords(a, ctx);
}

async function summaryOf(ctx: Context, id: string, t: Json, lang?: string): Promise<Json> {
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
    return { state: "pending", message: "The transcription is still running; wait for it (get_transcription with waitS), then ask again." };
  }
  if (s.state === "pending") return { state: "pending", message: "The summary is being written; ask again in a few seconds." };
  if (s.state === "unavailable") return { state: "unavailable", message: "Summaries are not available on this server." };
  const length = t.durationS ?? t.job?.source?.durationS;
  if (typeof length === "number" && length < 60) {
    return { state: "not_requested", message: "Transcriptions shorter than a minute are not summarised." };
  }
  return { state: "none", message: "No summary was asked for; update_transcription with summary true writes one." };
}

async function writeSummary(ctx: Context, id: string, t: Json): Promise<Json> {
  const current = await summaryOf(ctx, id, t);
  if (current.state === "ready" || current.state === "unavailable" || current.state === "not_requested") return current;
  if ((t.job && !TERMINAL.has(t.job.state)) || (!t.job && OPEN.has(t.state))) {
    throw new ToolError("invalid_state", "The transcription is still running; wait for it (get_transcription with waitS), then ask for the summary.");
  }
  if (current.state === "pending") return current;
  const made = (await ctx.api.request("POST", path("/v1/transcriptions/", id, "/summarize"), { signal: ctx.signal })).data;
  switch (made.state) {
    case "ready":
      return { state: "ready", title: made.title ?? t.name, summary: made.summary };
    case "unavailable":
      return { state: "unavailable", message: "Summaries are not available on this server." };
    case "not_requested":
      return { state: "not_requested", message: "Transcriptions shorter than a minute are not summarised." };
    default:
      return { state: "pending", message: "The summary is being written; ask again in a few seconds." };
  }
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

function noSpeaker(number: number): ToolError {
  return new ToolError("not_found", `This transcription has no Speaker ${number} who has spoken; get_transcription shows the speaker numbers.`);
}

async function saveSpeaker(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  const number = a.int("speaker", 1, 1, 1000);
  const name = a.reqStr("name");
  if ([...name].length > 60) throw bad("`name` must be 1 to 60 characters");
  const consent = a.bool("consent");
  await transcription(ctx, id);
  const snap = await snapshot(ctx, id);
  const spoken = spokenSegments(snap).filter((l) => l.speaker >= 0);
  const numbers = numbering(spoken, snap);
  const heard = new Set(spoken.map((l) => l.speaker));
  const appearance = [...numbers.entries()]
    .filter(([idx, n]) => n === number && heard.has(idx))
    .map(([idx]) => idx)
    .sort((x, y) => x - y)[0];
  if (appearance === undefined) throw noSpeaker(number);
  let s: Json;
  try {
    s = (
      await ctx.api.request("POST", "/v1/speakers/from-appearance", {
        json: { transcriptionId: id, appearance, name, consent },
        signal: ctx.signal,
      })
    ).data;
  } catch (e) {
    if (e instanceof ToolError && e.code === "not_found" && e.message.includes("has not said anything")) throw noSpeaker(number);
    throw e;
  }
  const out: Json = { speakerId: s.id, name: s.name, consent: s.consent, cloned: s.voice != null };
  if (s.voice) put(out, "voiceState", s.voice.state);
  return out;
}

async function deleteSpeaker(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("speakerId");
  try {
    await ctx.api.request("DELETE", path("/v1/speakers/", id), { signal: ctx.signal });
  } catch (e) {
    if (e instanceof ToolError && (e.code === "not_found" || (e.code === "forbidden" && !e.details.requiredScope))) {
      throw new ToolError("not_found", NO_SPEAKER);
    }
    throw e;
  }
  return { speakerId: id, deleted: true };
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

async function oneBroadcast(a: Args, ctx: Context): Promise<Json> {
  const b = await broadcast(ctx, a.id("broadcastId"));
  const v = brief(b);
  v.transcriptions = (b.transcriptions ?? []).slice(0, 20).map((t: Json) => {
    const o: Json = { transcriptionId: t.id, name: t.name, recording: t.recording };
    put(o, "lastRecordedAt", t.lastRecordedAt);
    return o;
  });
  v.streams = (b.audioSources ?? []).map((s: Json) => ({ name: s.name, url: s.url }));
  return { broadcasts: [v] };
}

async function listBroadcasts(a: Args, ctx: Context): Promise<Json> {
  if (a.str("broadcastId") !== undefined) return oneBroadcast(a, ctx);
  const lifecycle = a.oneOf("lifecycle", ["active", "archived", "all"], "active");
  const list = await all(ctx, "/v1/broadcasts", "broadcasts", { lifecycle });
  return { broadcasts: list.map(brief) };
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

async function deleteTranscription(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  await transcription(ctx, id);
  let t: Json;
  try {
    t = (await ctx.api.request("POST", path("/v1/transcriptions/", id, "/archive"), { signal: ctx.signal })).data;
  } catch (e) {
    if (e instanceof ToolError && e.code === "invalid_state" && e.message.includes("stop the recording first")) {
      throw new ToolError(
        "invalid_state",
        "This transcription is still recording live; stop it first (stop_broadcast for a broadcast), then delete it.",
      );
    }
    throw e;
  }
  const out: Json = { transcriptionId: t.id, name: t.name, deleted: true };
  put(out, "deletedAt", t.archivedAt);
  put(out, "restorableUntil", t.purgeAfter);
  return out;
}

function optBool(a: Args, k: string): boolean | undefined {
  const v = a.raw[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw bad(`\`${k}\` must be true or false`);
  return v;
}

function speakerTarget(a: Args): boolean {
  const sid = present(a, "speakerId");
  const tid = present(a, "transcriptionId");
  const spk = present(a, "speaker");
  if (sid && !tid && !spk) return true;
  if (!sid && tid && spk) return false;
  if (sid) throw bad("give either `speakerId` (a saved speaker) or `transcriptionId` with `speaker`, not both");
  if (tid) throw bad("`speaker` is required with `transcriptionId`");
  if (spk) throw bad("`transcriptionId` is required with `speaker`");
  throw bad("give `transcriptionId` with `speaker` (one transcription) or `speakerId` (a saved speaker)");
}

function noSavedSpeaker(e: unknown): never {
  if (e instanceof ToolError && (e.code === "not_found" || (e.code === "forbidden" && !e.details.requiredScope))) {
    throw new ToolError("not_found", NO_SPEAKER);
  }
  throw e;
}

async function savedSpeaker(ctx: Context, id: string): Promise<Json> {
  try {
    return await ctx.api.get(path("/v1/speakers/", id), undefined, ctx.signal);
  } catch (e) {
    noSavedSpeaker(e);
  }
}

async function patchSpeaker(ctx: Context, id: string, body: Json): Promise<void> {
  try {
    await ctx.api.request("PATCH", path("/v1/speakers/", id), { json: body, signal: ctx.signal });
  } catch (e) {
    noSavedSpeaker(e);
  }
}

async function updateSavedSpeaker(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("speakerId");
  let name: string | undefined;
  const given = a.raw.name;
  if (given !== undefined && given !== null) {
    if (typeof given !== "string") throw bad("`name` must be a string");
    name = given.trim();
    const n = [...name].length;
    if (n === 0 || n > 60) throw bad("a saved speaker's `name` must be 1 to 60 characters");
  }
  const cloned = optBool(a, "clonedVoice");
  const consent = a.bool("consent");
  if (name === undefined && cloned === undefined) throw bad("give `name`, `clonedVoice` or both to change a saved speaker");
  if (cloned === true && !consent) {
    throw bad("Turning a saved speaker's cloned voice on needs consent: true, confirming that person agreed to have their voice cloned.");
  }
  const report = (s: Json): Json => {
    const out: Json = {
      speakerId: s.id,
      name: s.name,
      consent: s.consent,
      clonedVoice: s.voice?.enabled === true && s.consent === "granted",
    };
    if (s.voice) put(out, "voiceState", s.voice.state);
    return out;
  };
  if (cloned === undefined) {
    try {
      return report((await ctx.api.request("PATCH", path("/v1/speakers/", id), { json: { name }, signal: ctx.signal })).data);
    } catch (e) {
      noSavedSpeaker(e);
    }
  }
  const cur = await savedSpeaker(ctx, id);
  if (cloned === true && cur.consent === "refused") {
    throw new ToolError(
      "invalid_state",
      "This speaker refused to be cloned and their audio was deleted; save them again from a transcription (save_speaker with consent) to clone them.",
    );
  }
  if (name !== undefined) await patchSpeaker(ctx, id, { name });
  if (cloned === true) {
    let s: Json;
    try {
      s = (await ctx.api.request("POST", path("/v1/speakers/", id, "/consent"), { json: { consent: "granted" }, signal: ctx.signal })).data;
    } catch (e) {
      if (e instanceof ToolError && e.code === "invalid_state" && e.message.includes("no sample stored")) {
        throw new ToolError(
          "invalid_state",
          "This saved speaker has no stored sample to clone their voice from; save them again from a transcription (save_speaker with consent).",
        );
      }
      noSavedSpeaker(e);
    }
    if (s?.voice && s.voice.enabled === false) await patchSpeaker(ctx, id, { enabled: true });
  } else if (cloned === false && cur.voice?.enabled === true) {
    await patchSpeaker(ctx, id, { enabled: false });
  }
  return report(await savedSpeaker(ctx, id));
}

async function updateSpeaker(a: Args, ctx: Context): Promise<Json> {
  if (speakerTarget(a)) return updateSavedSpeaker(a, ctx);
  if (present(a, "clonedVoice")) {
    throw bad("`clonedVoice` is for a saved speaker (speakerId); for everyone in one transcription use update_transcription with clonedVoices");
  }
  const id = a.id("transcriptionId");
  const number = a.int("speaker", 1, 1, 1000);
  const given = a.raw.name;
  if (given === undefined || given === null) throw bad('`name` is required with `transcriptionId` and `speaker` ("" clears the name)');
  if (typeof given !== "string") throw bad('`name` must be a string ("" clears the name)');
  const name = [...given.trim()].slice(0, 80).join("");
  await transcription(ctx, id);
  try {
    await ctx.api.request("PUT", path("/v1/transcriptions/", id, "/appearances/", String(number)), {
      json: { name: name || null },
      signal: ctx.signal,
    });
  } catch (e) {
    if (e instanceof ToolError && e.code === "not_found") {
      throw new ToolError("not_found", `This transcription has no Speaker ${number}; get_transcription shows the speaker numbers.`);
    }
    throw e;
  }
  return { transcriptionId: id, speaker: number, name: name || null };
}

const VOICE_CLONING_NEEDS_CONSENT =
  "turning voiceCloning on needs voiceCloningConsent: true — confirm you have permission from everyone speaking";
const NEEDS_CONSENT = "Turning cloned voices on needs consent: true, confirming everyone speaking agreed to have their voice cloned.";

function consentError(e: unknown): never {
  if (e instanceof ToolError && e.message === VOICE_CLONING_NEEDS_CONSENT) throw bad(NEEDS_CONSENT);
  throw e;
}

async function updateTranscription(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("transcriptionId");
  let name = a.str("name");
  if (name !== undefined) {
    name = name.trim();
    const n = [...name].length;
    if (n === 0 || n > 200) throw bad("`name` must be 1 to 200 characters");
  }
  const share = optBool(a, "shareLink");
  const summary = optBool(a, "summary");
  const cloned = optBool(a, "clonedVoices");
  const consent = a.bool("consent");
  if (summary === false) throw bad("`summary` takes only true (write one now); a summary is never deleted");
  if (name === undefined && share === undefined && summary === undefined && cloned === undefined) {
    throw bad("give at least one of `name`, `shareLink`, `summary` or `clonedVoices` to change");
  }
  if (cloned === true && !consent) throw bad(NEEDS_CONSENT);
  let t = await transcription(ctx, id);
  if (t.lifecycle && t.lifecycle !== "active") {
    throw new ToolError("invalid_state", "This transcription is in the trash; restore it in the VocalStack Dashboard first.");
  }
  const written = summary === true ? await writeSummary(ctx, id, t) : undefined;
  if (name !== undefined || cloned !== undefined) {
    const body: Json = {};
    if (name !== undefined) body.name = name;
    if (cloned !== undefined) body.settings = { voiceCloning: cloned, voiceCloningConsent: consent };
    try {
      t = (await ctx.api.request("PATCH", path("/v1/transcriptions/", id), { json: body, signal: ctx.signal })).data;
    } catch (e) {
      consentError(e);
    }
  }
  let links: Json[] = (await ctx.api.get(path("/v1/transcriptions/", id, "/share-links"), undefined, ctx.signal))?.links ?? [];
  if (share === true && links.length === 0) {
    const l = (await ctx.api.request("POST", path("/v1/transcriptions/", id, "/share-links"), { json: { label: "Shared link" }, signal: ctx.signal })).data;
    links = [l];
  } else if (share === false) {
    for (const l of links) await ctx.api.request("DELETE", path("/v1/share-links/", l.id), { signal: ctx.signal });
    links = [];
  }
  const out: Json = { transcriptionId: t.id, name: t.name, shareUrl: links[0]?.url ?? null, clonedVoices: t.settings?.voiceCloning === true };
  if (written) out.summary = written;
  return out;
}

async function updateBroadcast(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("broadcastId");
  const name = a.str("name");
  const access = a.raw.access === undefined || a.raw.access === null ? undefined : a.oneOf("access", ["public", "private"], "public");
  const password = a.str("password");
  const spokenRaw = a.str("spokenLanguage");
  const speak = optBool(a, "spokenTranslations");
  const cloned = optBool(a, "clonedVoices");
  const consent = a.bool("consent");
  if ([name, access, password, spokenRaw, speak, cloned].every((v) => v === undefined)) {
    throw bad("give at least one of `name`, `access`, `password`, `spokenLanguage`, `spokenTranslations` or `clonedVoices` to change");
  }
  if (cloned === true && !consent) throw bad(NEEDS_CONSENT);
  await broadcast(ctx, id);
  const body: Json = {};
  if (name !== undefined) body.name = name;
  if (access !== undefined) body.access = access;
  if (password !== undefined && access !== "public") body.password = password;
  const settings: Json = {};
  if (spokenRaw !== undefined) {
    const l = spokenRaw.trim().toLowerCase();
    settings.spokenLanguage = l === "" || l === "auto" ? null : l;
  }
  if (speak !== undefined) settings.translationTts = speak;
  if (cloned !== undefined) {
    settings.voiceCloning = cloned;
    settings.voiceCloningConsent = consent;
  }
  if (Object.keys(settings).length) body.settings = settings;
  let b: Json;
  try {
    b = (await ctx.api.request("PATCH", path("/v1/broadcasts/", id), { json: body, signal: ctx.signal })).data;
  } catch (e) {
    if (e instanceof ToolError && e.code === "invalid_state") {
      throw new ToolError("invalid_state", "This broadcast is in the trash; restore it in the VocalStack Dashboard first.");
    }
    if (e instanceof ToolError && e.message === "private broadcasts need a password") {
      throw bad("A private broadcast needs a `password` (at least 4 characters) the first time.");
    }
    consentError(e);
  }
  return {
    ...brief(b),
    spokenLanguage: b.settings?.spokenLanguage ?? "auto",
    spokenTranslations: b.settings?.translationTts === true,
    clonedVoices: b.settings?.voiceCloning === true,
  };
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

async function deleteBroadcast(a: Args, ctx: Context): Promise<Json> {
  const id = a.id("broadcastId");
  await broadcast(ctx, id);
  let b: Json;
  try {
    b = (await ctx.api.request("POST", path("/v1/broadcasts/", id, "/archive"), { signal: ctx.signal })).data;
  } catch (e) {
    if (e instanceof ToolError && e.code === "invalid_state" && e.message.includes("stop the recording first")) {
      throw new ToolError("invalid_state", "This broadcast is on air; stop it first (stop_broadcast), then delete it.", { broadcastId: id });
    }
    throw e;
  }
  const out: Json = { broadcastId: b.id, name: b.name, deleted: true };
  put(out, "deletedAt", b.archivedAt);
  put(out, "restorableUntil", b.purgeAfter);
  return out;
}

export const handlers: Record<string, Handler> = {
  create_transcription: createTranscription,
  get_transcription: getTranscription,
  list_transcriptions: listTranscriptions,
  search_transcriptions: search,
  update_transcription: updateTranscription,
  delete_transcription: deleteTranscription,
  list_speakers: speakers,
  save_speaker: saveSpeaker,
  update_speaker: updateSpeaker,
  delete_speaker: deleteSpeaker,
  list_broadcasts: listBroadcasts,
  start_broadcast: startBroadcast,
  update_broadcast: updateBroadcast,
  stop_broadcast: stopBroadcast,
  delete_broadcast: deleteBroadcast,
};
