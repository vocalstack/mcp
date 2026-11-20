import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeApi, apiError, connect, call, KEY, DEFS, VERSION } from "./helpers.mjs";

const TID = "0190f0e0-7c1a-7d3e-9b2a-5f4e3d2c1b0a";
const BID = "0190f0e0-0000-7000-8000-00000000000b";
const SRC = "0190f0e0-0000-7000-8000-0000000000aa";
const SPK = "0190f0e0-0000-7000-8000-0000000000c1";
const T0 = "2026-11-19T10:00:00Z";
const LANGS = ["en", "es", "fr", "de", "ja"];

const job = (state, progress = {}, extra = {}) => ({
  transcriptionId: TID,
  state,
  attempts: 0,
  createdAt: T0,
  hasAudio: true,
  progress: { pct: 0, processedS: 0, segmentsDone: 0, totalS: 120, ...progress },
  source: { kind: "url", name: "episode.mp3", durationS: 120, format: "mp3" },
  ...extra,
});
const tx = (extra = {}) => ({
  id: TID,
  name: "Episode 12",
  createdAt: T0,
  state: "idle",
  lifecycle: "active",
  spokenLanguage: "en",
  settings: { speakerLabels: "auto", voiceCloning: false },
  broadcasts: [],
  job: job("queued"),
  ...extra,
});
const liveTx = (state, extra = {}) =>
  tx({ job: null, state, startedAt: "2026-11-19T10:01:00Z", durationS: 30, broadcasts: [{ id: BID }], ...extra });

const snapshot = (extra = {}) => ({
  transcriptionId: TID,
  lastSeq: 3,
  state: "finalized",
  speakerLabels: "auto",
  speakers: [
    { speaker: 0, name: "Ana", number: 1 },
    { speaker: 1, name: "", number: 2 },
  ],
  segments: [
    { seq: 1, start: 0.5, end: 3, speaker: 0, text: " Hello there. ", language: "en", words: [{ text: "Hello", start: 0.5, end: 1, prob: 0.9 }] },
    { seq: 2, start: 3.5, end: 5, speaker: 1, text: "Hi Ana.", language: "en", words: [] },
    { seq: 3, start: 6, end: 6.5, speaker: 1, text: "  ", language: "en", words: [] },
    { seq: 4, start: 75.4, end: 80, speaker: 0, text: "Bye.", language: "en", words: [] },
  ],
  sentences: [
    { sentenceId: 10, seqs: [1], start: 0.5, end: 3, speaker: 0, text: "Hello there.", status: "final", language: "en", translations: { es: "Hola." } },
    { sentenceId: 11, seqs: [2], start: 3.5, end: 5, speaker: 1, text: "Hi Ana.", status: "final", language: "en", translations: {} },
    { sentenceId: 12, seqs: [3], start: 5.5, end: 6, speaker: 1, text: "gone", status: "dropped", language: "en" },
    { sentenceId: 13, seqs: [4], start: 75.4, end: 80, speaker: 0, text: "Bye.", status: "final", language: "en", translations: {} },
  ],
  spans: [],
  ...extra,
});

const bcast = (extra = {}) => ({
  id: BID,
  name: "Sunday service",
  shareUrl: "https://vocalstack.com/sunday",
  access: "public",
  lifecycle: "active",
  listenersNow: 3,
  audioSources: [],
  transcriptions: [],
  currentTranscription: null,
  ...extra,
});

const fake = new FakeApi();
let client;
let languageCalls = 0;

before(async () => {
  await fake.start();
  fake.always("GET", "/v1/languages", () => {
    languageCalls++;
    return { body: { languages: [], transcription: LANGS, translation: LANGS, voice: ["en"] } };
  });
  client = await connect(fake);
});

after(async () => {
  await client?.close();
  await fake.stop();
});

beforeEach(() => fake.reset());

function only(method, path) {
  return fake.requests.filter((r) => r.method === method && r.path === path);
}

function seen() {
  return fake.requests.filter((r) => r.path !== "/v1/languages" && !(r.method === "GET" && r.path.endsWith("/share-links"))).map((r) => `${r.method} ${r.path}`);
}

test("initialize carries the stored instructions and this package's version", () => {
  assert.deepEqual(client.getServerVersion(), { name: "vocalstack", version: VERSION });
  assert.equal(client.getInstructions(), DEFS.instructions);
  assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: false });
});

test("tools/list is exactly the hosted definitions: fifteen tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools, DEFS.tools);
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "create_transcription",
      "get_transcription",
      "list_transcriptions",
      "search_transcriptions",
      "update_transcription",
      "delete_transcription",
      "list_speakers",
      "update_speaker",
      "delete_speaker",
      "list_broadcasts",
      "start_broadcast",
      "update_broadcast",
      "stop_broadcast",
      "delete_broadcast",
      "get_account",
    ],
  );
});

test("every request carries the key, the user agent and asks for JSON", async () => {
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  await call(client, "list_speakers", {});
  const r = fake.requests[0];
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.headers["user-agent"], `vocalstack-mcp/${VERSION}`);
  assert.equal(r.headers.accept, "application/json");
});

test("an unknown tool, or one the hosted refactor removed, is a protocol error", async () => {
  for (const name of ["nope", "transcribe", "restore_transcription", "transcribe_url", "transcribe_file", "wait_for_transcription", "translate_transcription", "search_by_meaning", "get_broadcast", "list_voices"]) {
    await assert.rejects(call(client, name, {}), (e) => {
      assert.equal(e.code, -32602);
      assert.match(e.message, new RegExp(`unknown tool "${name}"`));
      return true;
    });
  }
});

test("arguments are held to the schema, worded as the hosted server words them", async () => {
  let r = await call(client, "get_transcription", { transcriptionId: TID, bogus: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, "unknown argument `bogus`; this tool takes format, includeWords, lang, limit, offset, transcriptionId, waitS");
  r = await call(client, "get_transcription", {});
  assert.equal(r.content[0].text, "`transcriptionId` is required");
  r = await call(client, "get_transcription", { transcriptionId: "x" });
  assert.equal(r.content[0].text, "`transcriptionId` must be a UUID");
  r = await call(client, "get_transcription", { transcriptionId: TID, limit: 0 });
  assert.equal(r.content[0].text, "`limit` must be an integer from 1 to 2000");
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "pdf" });
  assert.equal(r.content[0].text, "`format` must be one of text, segments, summary, srt, vtt, markdown, none");
  r = await call(client, "get_transcription", { transcriptionId: TID, waitS: 61 });
  assert.equal(r.content[0].text, "`waitS` must be an integer from 0 to 60");
  r = await call(client, "get_transcription", { transcriptionId: TID, waitS: -1 });
  assert.equal(r.content[0].text, "`waitS` must be an integer from 0 to 60");
  r = await call(client, "create_transcription", { url: "https://x", shareLink: "yes" });
  assert.equal(r.content[0].text, "`shareLink` must be true or false");
  r = await call(client, "search_transcriptions", { query: "a" });
  assert.equal(r.content[0].text, "`query` must be 2 to 200 characters");
  r = await call(client, "search_transcriptions", { query: "ab", mode: "sideways" });
  assert.equal(r.content[0].text, "`mode` must be one of words, meaning");
  r = await call(client, "create_transcription", { url: "https://x", idempotencyKey: "has space" });
  assert.equal(r.content[0].text, "idempotencyKey must be 1 to 255 visible ASCII characters");
  r = await call(client, "create_transcription", { url: "https://x", timeoutS: 5 });
  assert.equal(
    r.content[0].text,
    "unknown argument `timeoutS`; this tool takes endS, fileBase64, filename, idempotencyKey, mimeType, name, shareLink, speakerLabels, spokenLanguage, startS, summary, url",
  );
  assert.deepEqual(seen(), []);
});

test("create_transcription with url posts the link and options, with the idempotency key, and returns the status", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx() });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [{ url: "https://vocalstack.com/t/abc" }] } });
  const r = await call(client, "create_transcription", {
    url: "https://example.com/episode-12.mp3",
    name: "Episode 12",
    spokenLanguage: "en",
    speakerLabels: "on",
    startS: 10,
    endS: 100,
    summary: true,
    shareLink: true,
    idempotencyKey: "ep-12",
  });
  assert.equal(r.isError, undefined);
  const [post] = only("POST", "/v1/transcriptions");
  assert.equal(post.headers["idempotency-key"], "ep-12");
  assert.match(post.headers["content-type"], /^application\/json/);
  assert.deepEqual(post.body, {
    url: "https://example.com/episode-12.mp3",
    name: "Episode 12",
    startS: 10,
    endS: 100,
    shareLink: true,
    settings: { spokenLanguage: "en", speakerLabels: "on", summary: true, title: true },
  });
  assert.deepEqual(r.structuredContent, {
    createdAt: T0,
    kind: "file",
    name: "Episode 12",
    next: "Call get_transcription with this transcriptionId and waitS (up to 60) to wait for the text.",
    progress: { pct: 0, processedS: 0, segmentsDone: 0, totalS: 120 },
    shareUrl: "https://vocalstack.com/t/abc",
    source: { durationS: 120, format: "mp3", kind: "url", name: "episode.mp3" },
    spokenLanguage: "en",
    state: "queued",
    transcriptionId: TID,
  });
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test("create_transcription with url: defaults are speaker labels auto, no share link, no key; a replay says so; a missing job is fetched", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx({ job: null }), headers: { "idempotent-replayed": "true" } });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("fetching") });
  const r = await call(client, "create_transcription", { url: "https://example.com/a.mp3", fileBase64: null });
  const [post] = only("POST", "/v1/transcriptions");
  assert.equal(post.headers["idempotency-key"], undefined);
  assert.deepEqual(post.body, { url: "https://example.com/a.mp3", shareLink: false, settings: { speakerLabels: "auto" } });
  assert.equal(r.structuredContent.replayed, true);
  assert.equal(r.structuredContent.state, "fetching");
  assert.deepEqual(seen(), ["POST /v1/transcriptions", `GET /v1/transcriptions/${TID}/job`]);
});

test("create_transcription with fileBase64 uploads the decoded file as multipart with its options", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx({ job: job("queued", {}, { source: { kind: "upload", name: "meeting.m4a" } }) }) });
  const bytes = Buffer.from("ID3 fake audio bytes \u0000\u0001\u0002");
  const r = await call(client, "create_transcription", {
    filename: "meeting.m4a",
    fileBase64: `data:audio/mp4;base64,${bytes.toString("base64").replace(/(.{8})/g, "$1\n")}`,
    mimeType: "audio/mp4",
    summary: true,
    idempotencyKey: "m-1",
    url: null,
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const [post] = only("POST", "/v1/transcriptions");
  assert.match(post.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.equal(post.headers["idempotency-key"], "m-1");
  assert.deepEqual(JSON.parse(post.body.options), { settings: { speakerLabels: "auto", summary: true, title: true }, shareLink: false });
  assert.equal(post.body.file.name, "meeting.m4a");
  assert.equal(post.body.file.type, "audio/mp4");
  assert.deepEqual(post.body.file.bytes, bytes);
  assert.equal(r.structuredContent.kind, "file");
  assert.deepEqual(r.structuredContent.source, { kind: "upload", name: "meeting.m4a" });
  assert.match(r.structuredContent.next, /^Call get_transcription with this transcriptionId and waitS/);
});

test("create_transcription takes exactly one source: url, or fileBase64 with filename", async () => {
  const cases = [
    [{ url: "https://example.com/a.mp3", fileBase64: "AAAA", filename: "a.mp3" }, "give either `url` or `fileBase64`, not both"],
    [{ name: "Nothing" }, "give `url` (a public link) or `fileBase64` with `filename` (a file up to 10 MiB)"],
    [{ url: null, fileBase64: null }, "give `url` (a public link) or `fileBase64` with `filename` (a file up to 10 MiB)"],
    [{ url: "https://example.com/a.mp3", filename: "a.mp3" }, "`filename` goes with `fileBase64`, not with `url`"],
    [{ url: "https://example.com/a.mp3", mimeType: "audio/mpeg" }, "`mimeType` goes with `fileBase64`, not with `url`"],
    [{ fileBase64: "AAAA" }, "`filename` is required"],
    [{ url: "   " }, "`url` is required"],
    [{ url: `https://example.com/${"a".repeat(2040)}` }, "`url` is longer than 2048 characters"],
    [{ fileBase64: 12, filename: "a.mp3" }, "`fileBase64` must be a string"],
  ];
  for (const [args, says] of cases) {
    const r = await call(client, "create_transcription", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(r.structuredContent.error, "invalid_options", JSON.stringify(args));
    assert.equal(r.content[0].text, says, JSON.stringify(args));
  }
  assert.deepEqual(seen(), []);
});

test("create_transcription refuses bad base64, an empty file and one over 10 MiB before any request", async () => {
  let r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: "AA*A" });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.match(r.content[0].text, /^fileBase64 is not valid base64/);
  r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: "@@@@" });
  assert.match(r.content[0].text, /not valid base64/);
  r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: "data:audio/mpeg;base64," });
  assert.equal(r.content[0].text, "`fileBase64` is required");
  r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: "====" });
  assert.equal(r.structuredContent.error, "invalid_options");
  r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: "" });
  assert.equal(r.content[0].text, "`fileBase64` is required");
  const over = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
  r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: over });
  assert.equal(r.content[0].text, "the file is over 10 MiB; give `url` a link to it instead");
  const big = Buffer.alloc(10 * 1024 * 1024 + 1024).toString("base64");
  r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: big });
  assert.equal(r.content[0].text, "fileBase64 is over 10 MiB decoded; give `url` a link to the file instead");
  assert.deepEqual(seen(), []);
});

test("create_transcription: an empty decoded file is invalid_audio", async () => {
  const r = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: " \n " });
  assert.equal(r.content[0].text, "`fileBase64` is required");
  const e = await call(client, "create_transcription", { filename: "a.mp3", fileBase64: "data:;base64,==" });
  assert.equal(e.structuredContent.error, "invalid_audio");
  assert.equal(e.content[0].text, "the file is empty");
  assert.equal(e.structuredContent.status, 400);
});

test("a 10 MiB file goes through stdio and up in one request", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx() });
  const bytes = Buffer.alloc(10 * 1024 * 1024, 7);
  const r = await call(client, "create_transcription", { filename: "big.wav", fileBase64: bytes.toString("base64") });
  assert.equal(r.isError, undefined, r.content[0]?.text);
  const [post] = only("POST", "/v1/transcriptions");
  assert.equal(post.body.file.bytes.length, bytes.length);
  assert.equal(post.body.file.type, "application/octet-stream");
});

test("get_transcription format srt, vtt or markdown returns the export as a file, in lang too", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  const srt = "1\n00:00:00,000 --> 00:00:02,000\nSpeaker 1: Hello.\n";
  fake.on("GET", `/v1/transcriptions/${TID}/export`, {
    text: srt,
    headers: { "content-type": "application/x-subrip; charset=utf-8", "content-disposition": "attachment; filename=\"Call.srt\"; filename*=UTF-8''Call.srt" },
  });
  let r = await call(client, "get_transcription", { transcriptionId: TID, format: "srt" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(r.structuredContent.file, { fileName: "Call.srt", contentType: "application/x-subrip", content: srt });
  const ask = only("GET", `/v1/transcriptions/${TID}/export`)[0];
  assert.equal(ask.query.format, "srt");
  assert.equal(ask.query.lang, undefined);
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "srt", includeWords: true });
  assert.equal(r.structuredContent.error, "invalid_options");
});

test("get_transcription pages readable text with speakers and marks a running one partial", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing", { pct: 40, processedS: 48 }) }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  let r = await call(client, "get_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.text, "[00:00] Ana: Hello there.\n[00:03] Speaker 2: Hi Ana.\n[01:15] Ana: Bye.");
  assert.equal(r.structuredContent.segmentCount, 3);
  assert.equal(r.structuredContent.partial, true);
  assert.equal(r.structuredContent.nextOffset, undefined);
  assert.equal(r.structuredContent.timedOut, undefined, "no wait asked, none reported");
  assert.equal(r.structuredContent.status.state, "transcribing");
  assert.equal(r.structuredContent.status.kind, "file");
  r = await call(client, "get_transcription", { transcriptionId: TID, offset: 1, limit: 1 });
  assert.equal(r.structuredContent.text, "[00:03] Speaker 2: Hi Ana.");
  assert.equal(r.structuredContent.nextOffset, 2);
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "segments", includeWords: true, limit: 1 });
  assert.deepEqual(r.structuredContent.segments, [
    { end: 3, language: "en", speaker: 0, speakerName: "Ana", speakerNumber: 1, start: 0.5, text: " Hello there. ", words: [{ end: 1, start: 0.5, text: "Hello" }] },
  ]);
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "none" });
  assert.deepEqual(Object.keys(r.structuredContent), ["status"]);
  assert.equal(only("GET", `/v1/transcriptions/${TID}/transcript`).length, 3);
  assert.equal(only("GET", `/v1/transcriptions/${TID}/job`).length, 0);
});

test("get_transcription: a live transcription reports kind live; labels off drops speakers", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("live") });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot({ speakerLabels: "off", state: "live" }) });
  const r = await call(client, "get_transcription", { transcriptionId: TID, format: "segments" });
  assert.deepEqual(r.structuredContent.status, {
    createdAt: T0,
    durationS: 30,
    kind: "live",
    name: "Episode 12",
    spokenLanguage: "en",
    startedAt: "2026-11-19T10:01:00Z",
    state: "live",
    transcriptionId: TID,
  });
  assert.equal(r.structuredContent.partial, true);
  assert.deepEqual(r.structuredContent.segments[0], { end: 3, language: "en", start: 0.5, text: " Hello there. " });
});

test("get_transcription: one speaker under auto labels still reads as Speaker 1", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  const one = snapshot();
  one.segments = one.segments.map((s) => ({ ...s, speaker: 0 }));
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: one });
  const r = await call(client, "get_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.text.split("\n")[0], "[00:00] Speaker 1: Hello there.");
  assert.equal(r.structuredContent.partial, undefined);
});

test("segments carry speakerNumber: the server's numbers first, then unnumbered speakers after the highest", async () => {
  const snap = snapshot({
    speakers: [
      { speaker: 0, name: "Ana", number: 3 },
      { speaker: 1, name: "", number: 1 },
    ],
  });
  snap.segments.push({ seq: 5, start: 90, end: 91, speaker: 4, text: "Late.", language: "en", words: [] });
  snap.sentences.push({ sentenceId: 14, seqs: [5], start: 90, end: 91, speaker: 4, text: "Late.", status: "final", language: "en", translations: { es: "Tarde." } });
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snap });
  fake.on("GET", `/v1/transcriptions/${TID}/translation`, { body: { lang: "es", translations: { 11: "Hola Ana.", 13: "Adiós." } } });
  let r = await call(client, "get_transcription", { transcriptionId: TID, format: "segments" });
  assert.deepEqual(
    r.structuredContent.segments.map((s) => [s.speaker, s.speakerNumber, s.speakerName]),
    [
      [0, 3, "Ana"],
      [1, 1, "Speaker 1"],
      [0, 3, "Ana"],
      [4, 4, "Speaker 4"],
    ],
  );
  r = await call(client, "get_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.text.split("\n")[1], "[00:03] Speaker 1: Hi Ana.");
  r = await call(client, "get_transcription", { transcriptionId: TID, lang: "es", format: "segments" });
  assert.deepEqual(
    r.structuredContent.segments.map((s) => [s.speakerNumber, s.speakerName, s.text]),
    [
      [3, "Ana", "Hola."],
      [1, "Speaker 1", "Hola Ana."],
      [3, "Ana", "Adiós."],
      [4, "Speaker 4", "Tarde."],
    ],
  );
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot({ speakerLabels: "off" }) });
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "segments" });
  assert.ok(r.structuredContent.segments.every((s) => s.speakerNumber === undefined && s.speaker === undefined));
});

test("an unknown id is not_found in the hosted wording", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(404, "not_found", "transcription not found"));
  const r = await call(client, "get_transcription", { transcriptionId: TID });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  assert.deepEqual(r.structuredContent, {
    details: {},
    error: "not_found",
    message: "No transcription with that id for this account.",
    retryAfterS: null,
    retryable: false,
    status: 404,
    topUpUrl: null,
  });
});

test("get_transcription with waitS 0 answers at once and reports no wait", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  const t0 = Date.now();
  const r = await call(client, "get_transcription", { transcriptionId: TID, waitS: 0 });
  assert.ok(Date.now() - t0 < 900);
  assert.equal(r.structuredContent.timedOut, undefined);
  assert.equal(r.structuredContent.partial, true);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `GET /v1/transcriptions/${TID}/transcript`]);
});

test("get_transcription with waitS polls the job each second until it is done, with progress, then reads the text in the same call", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("fetching", { pct: 0, fetchedBytes: 1_500_000, fetchTotalBytes: 3_000_000 }) }) });
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done", { pct: 100, processedS: 120 }, { finishedAt: "2026-11-19T10:05:00Z" }) }) });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("transcribing", { pct: 50, processedS: 60 }) });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("done", { pct: 100, processedS: 120 }, { finishedAt: "2026-11-19T10:05:00Z" }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  const updates = [];
  const t0 = Date.now();
  const r = await call(client, "get_transcription", { transcriptionId: TID, waitS: 50 }, { onprogress: (p) => updates.push(p) });
  const took = Date.now() - t0;
  assert.ok(took >= 1800 && took < 5000, `took ${took} ms`);
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.structuredContent.timedOut, false);
  assert.equal(r.structuredContent.status.state, "done");
  assert.equal(r.structuredContent.status.finishedAt, "2026-11-19T10:05:00Z");
  assert.equal(r.structuredContent.text, "[00:00] Ana: Hello there.\n[00:03] Speaker 2: Hi Ana.\n[01:15] Ana: Bye.");
  assert.equal(r.structuredContent.partial, undefined);
  assert.deepEqual(seen(), [
    `GET /v1/transcriptions/${TID}`,
    `GET /v1/transcriptions/${TID}/job`,
    `GET /v1/transcriptions/${TID}/job`,
    `GET /v1/transcriptions/${TID}`,
    `GET /v1/transcriptions/${TID}/transcript`,
  ]);
  assert.deepEqual(
    updates.map((u) => [u.progress, u.total, u.message]),
    [
      [0, 100, "fetching 1.5 / 3.0 MB"],
      [50, 100, "transcribing 01:00 of 02:00"],
    ],
  );
});

test("get_transcription with waitS: a wait that runs out is timedOut true, not an error; format none waits without reading", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("queued") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("queued") });
  const t0 = Date.now();
  const r = await call(client, "get_transcription", { transcriptionId: TID, waitS: 1, format: "none" });
  assert.ok(Date.now() - t0 >= 900, "it waited");
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.timedOut, true);
  assert.equal(r.structuredContent.status.state, "queued");
  assert.deepEqual(Object.keys(r.structuredContent).sort(), ["status", "timedOut"]);
  assert.equal(only("GET", `/v1/transcriptions/${TID}/transcript`).length, 0);
  assert.ok(only("GET", `/v1/transcriptions/${TID}/job`).length >= 1);
});

test("get_transcription with waitS: a live one and a finished one do not wait (timedOut false) and are read at once", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("live") });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot({ state: "live" }) });
  let t0 = Date.now();
  let r = await call(client, "get_transcription", { transcriptionId: TID, waitS: 30 });
  assert.ok(Date.now() - t0 < 900);
  assert.equal(r.structuredContent.timedOut, false);
  assert.equal(r.structuredContent.status.kind, "live");
  assert.equal(r.structuredContent.partial, true);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `GET /v1/transcriptions/${TID}/transcript`]);
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("failed", {}, { error: "the link could not be read" }) }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot({ segments: [], sentences: [] }) });
  t0 = Date.now();
  r = await call(client, "get_transcription", { transcriptionId: TID, waitS: 30 });
  assert.ok(Date.now() - t0 < 900);
  assert.equal(r.structuredContent.timedOut, false);
  assert.equal(r.structuredContent.status.error, "the link could not be read");
  assert.equal(r.structuredContent.text, "");
  assert.equal(r.structuredContent.segmentCount, 0);
  assert.equal(only("GET", `/v1/transcriptions/${TID}/job`).length, 0);
});

test("get_transcription with waitS: at most four waits are open for this key at once", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("transcribing") });
  const waits = Array.from({ length: 4 }, () => call(client, "get_transcription", { transcriptionId: TID, waitS: 2, format: "none" }));
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  const fifth = await call(client, "get_transcription", { transcriptionId: TID, waitS: 2, format: "none" });
  assert.ok(Date.now() - t0 < 1000, "refused at once");
  assert.equal(fifth.isError, true);
  assert.equal(fifth.structuredContent.error, "rate_limited");
  assert.equal(fifth.structuredContent.status, 429);
  assert.equal(fifth.structuredContent.retryable, true);
  assert.equal(fifth.structuredContent.retryAfterS, 5);
  assert.deepEqual(fifth.structuredContent.details, { limit: 4, retryAfterS: 5 });
  assert.equal(fifth.content[0].text, "this key already has 4 waits open; let one finish first. Wait 5 seconds before trying again.");
  for (const r of await Promise.all(waits)) assert.equal(r.structuredContent.timedOut, true);
  const again = await call(client, "get_transcription", { transcriptionId: TID, waitS: 1, format: "none" });
  assert.equal(again.structuredContent.timedOut, true, "the slots are free again");
});

test("get_transcription with lang translates only the sentences on the page that lack it", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", `/v1/transcriptions/${TID}/translation`, { body: { lang: "es", translations: { 11: "Hola Ana." } } });
  fake.on("GET", `/v1/transcriptions/${TID}/translation`, { body: { lang: "es", translations: { 13: "Adiós." } } });
  const r = await call(client, "get_transcription", { transcriptionId: TID, lang: "ES", limit: 2 });
  assert.deepEqual(only("GET", `/v1/transcriptions/${TID}/translation`)[0].query, { lang: "es", sentences: "11" });
  assert.equal(r.structuredContent.status.state, "done");
  const { status, ...rest } = r.structuredContent;
  assert.deepEqual(rest, {
    lang: "es",
    nextOffset: 2,
    segmentCount: 3,
    text: "[00:00] Ana: Hola.\n[00:03] Speaker 2: Hola Ana.",
    translated: true,
  });
  const s = await call(client, "get_transcription", { transcriptionId: TID, lang: "es", format: "segments", offset: 2 });
  assert.deepEqual(only("GET", `/v1/transcriptions/${TID}/translation`)[1].query, { lang: "es", sentences: "13" });
  assert.deepEqual(s.structuredContent.segments, [{ end: 80, language: "es", speaker: 0, speakerName: "Ana", speakerNumber: 1, start: 75.4, text: "Adiós." }]);
  const n = await call(client, "get_transcription", { transcriptionId: TID, lang: "es", format: "none" });
  assert.deepEqual(Object.keys(n.structuredContent), ["status"]);
});

test("get_transcription with lang: the spoken language comes back untranslated", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  const r = await call(client, "get_transcription", { transcriptionId: TID, lang: "en" });
  assert.equal(r.structuredContent.translated, false);
  assert.equal(r.structuredContent.lang, "en");
  assert.equal(r.structuredContent.segmentCount, 3);
  assert.equal(r.structuredContent.text, "[00:00] Ana: Hello there.\n[00:03] Speaker 2: Hi Ana.\n[01:15] Ana: Bye.");
  assert.equal(only("GET", `/v1/transcriptions/${TID}/translation`).length, 0);
});

test("get_transcription with lang refuses an open live transcription and an unfinished file, unless a wait ran out", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("live") });
  let r = await call(client, "get_transcription", { transcriptionId: TID, lang: "es" });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.content[0].text, "the live transcription is still running; read the text so far without lang, or stop it (stop_broadcast) and translate it then");
  r = await call(client, "get_transcription", { transcriptionId: TID, lang: "es", waitS: 5 });
  assert.equal(r.structuredContent.error, "invalid_state", "a live one never waits, so nothing ran out");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing") }) });
  r = await call(client, "get_transcription", { transcriptionId: TID, lang: "es" });
  assert.equal(r.content[0].text, "the transcription is transcribing; wait until it is done (get_transcription with waitS)");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("transcribing") });
  r = await call(client, "get_transcription", { transcriptionId: TID, lang: "es", waitS: 1 });
  assert.equal(r.isError, undefined, "a wait that runs out is not an error");
  assert.equal(r.structuredContent.timedOut, true);
  assert.deepEqual(Object.keys(r.structuredContent).sort(), ["status", "timedOut"]);
  assert.equal(only("GET", `/v1/transcriptions/${TID}/transcript`).length, 0);
});

test("get_transcription with lang: an unsupported language and includeWords are refused before any request", async () => {
  let r = await call(client, "get_transcription", { transcriptionId: TID, lang: "xx-nope" });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, '`lang` "xx-nope" is not a language this API translates into');
  r = await call(client, "get_transcription", { transcriptionId: TID, lang: "es", includeWords: true, format: "segments" });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, "`includeWords` is for the original language; leave it out with `lang`");
  r = await call(client, "get_transcription", { transcriptionId: TID, lang: "  " });
  assert.equal(r.structuredContent.error, "not_found", "a blank lang is no lang");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);
});

test("list_transcriptions maps file and live rows and fills the page across cursors", async () => {
  fake.on("GET", "/v1/transcriptions", {
    body: {
      transcriptions: [tx({ job: job("done"), title: "Pricing call" })],
      nextCursor: "c1",
    },
  });
  fake.on("GET", "/v1/transcriptions", {
    body: { transcriptions: [liveTx("processing", { id: "t2" })], nextCursor: "c2" },
  });
  const r = await call(client, "list_transcriptions", { lifecycle: "all", limit: 2, cursor: "c0" });
  const reqs = only("GET", "/v1/transcriptions");
  assert.deepEqual(reqs.map((q) => q.query), [
    { lifecycle: "all", cursor: "c0", limit: "2" },
    { lifecycle: "all", cursor: "c1", limit: "1" },
  ]);
  assert.deepEqual(r.structuredContent, {
    nextCursor: "c2",
    transcriptions: [
      { createdAt: T0, durationS: 120, kind: "file", name: "Episode 12", state: "done", title: "Pricing call", transcriptionId: TID },
      { broadcastId: BID, createdAt: T0, durationS: 30, kind: "live", name: "Episode 12", state: "finishing", transcriptionId: "t2" },
    ],
  });
});

test("list_transcriptions: a bad cursor is named", async () => {
  fake.on("GET", "/v1/transcriptions", apiError(400, "invalid_options", "bad cursor"));
  const r = await call(client, "list_transcriptions", { cursor: "zzz" });
  assert.equal(r.content[0].text, "`cursor` is not one this tool gave out");
});

const wordsHits = {
  query: "budget",
  queryEn: "budget",
  more: false,
  hits: [
    { transcriptionId: TID, linkName: "Episode 12", linkCode: "abc", mediaStart: 12.5, wallStart: 12.5, speaker: 1, text: "The budget.", score: 0.9, live: false, sentenceId: 4, rendered: "El presupuesto.", recordedAt: T0 },
  ],
};

test("search_transcriptions (mode words, the default) checks the transcription, then searches", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("GET", "/v1/search", { body: wordsHits });
  const r = await call(client, "search_transcriptions", { query: " budget ", transcriptionId: TID, lang: "es", limit: 5 });
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, "GET /v1/search"]);
  assert.deepEqual(only("GET", "/v1/search")[0].query, { q: "budget", transcription: TID, lang: "es", limit: "5" });
  assert.deepEqual(r.structuredContent, {
    hits: [{ live: false, mediaStart: 12.5, name: "Episode 12", recordedAt: T0, rendered: "El presupuesto.", score: 0.9, speaker: 1, text: "The budget.", transcriptionId: TID }],
    query: "budget",
    queryEn: "budget",
  });
  fake.requests = [];
  const w = await call(client, "search_transcriptions", { query: "budget", mode: "words" });
  assert.deepEqual(seen(), ["GET /v1/search"]);
  assert.deepEqual(only("GET", "/v1/search")[0].query, { q: "budget", limit: "20" });
  assert.deepEqual(w.structuredContent, r.structuredContent);
});

const vectorHits = {
  query: "hiring",
  state: "ready",
  allowance: { limit: 60, remaining: 59, resetsAt: null },
  hits: [
    { transcriptionId: TID, linkName: "Episode 12", linkCode: "abc", mediaStart: 30, wallStart: 30, speaker: 0, text: "We hire.", score: 1, live: true, sentenceId: 1, vector: true, similarity: 0.81234, passage: { text: "We hire two people.", mediaStart: 28, mediaEnd: 40 } },
  ],
};

test("search_transcriptions mode meaning returns passages and what is left this hour", async () => {
  fake.on("GET", "/v1/search/vector", { body: vectorHits });
  let r = await call(client, "search_transcriptions", { query: "What about hiring?", mode: "meaning" });
  assert.deepEqual(seen(), ["GET /v1/search/vector"]);
  assert.deepEqual(only("GET", "/v1/search/vector")[0].query, { q: "What about hiring?" });
  assert.deepEqual(r.structuredContent, {
    passages: [{ live: true, mediaEnd: 40, mediaStart: 28, name: "Episode 12", similarity: 0.812, text: "We hire two people.", transcriptionId: TID }],
    query: "hiring",
    searchesLeftThisHour: 59,
    state: "ready",
  });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("GET", "/v1/search/vector", { body: { query: "x y", state: "off", allowance: { limit: null, remaining: null }, hits: [] } });
  r = await call(client, "search_transcriptions", { query: "x y", mode: "meaning", transcriptionId: TID });
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, "GET /v1/search/vector"]);
  assert.deepEqual(only("GET", "/v1/search/vector")[0].query, { q: "x y", transcription: TID });
  assert.deepEqual(r.structuredContent, { passages: [], query: "x y", state: "off" });
});

test("search_transcriptions mode meaning refuses lang and limit, and an unknown transcriptionId", async () => {
  let r = await call(client, "search_transcriptions", { query: "hello", mode: "meaning", lang: "en" });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, "`lang` applies to mode words only; leave it out with mode meaning");
  r = await call(client, "search_transcriptions", { query: "hello", mode: "meaning", limit: 5 });
  assert.equal(r.content[0].text, "`limit` applies to mode words only; leave it out with mode meaning");
  r = await call(client, "search_transcriptions", { query: "hello", mode: "meaning", lang: null, limit: null, transcriptionId: "nope" });
  assert.equal(r.content[0].text, "`transcriptionId` must be a UUID");
  assert.deepEqual(seen(), []);
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(404, "not_found", "transcription not found"));
  r = await call(client, "search_transcriptions", { query: "hello", mode: "meaning", transcriptionId: TID });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);
  fake.reset();
  fake.on("GET", "/v1/search/vector", apiError(429, "rate_limited", "Too many searches by meaning this hour.", { retryAfterS: 120 }, true));
  r = await call(client, "search_transcriptions", { query: "hello", mode: "meaning" });
  assert.equal(r.structuredContent.retryAfterS, 120);
  assert.equal(r.content[0].text, "Too many searches by meaning this hour. Wait 120 seconds before trying again.");
});

test("get_transcription format summary reads a ready summary in a language and never writes one", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "ready", title: "Titre", summary: "Résumé", lang: "fr" } });
  let r = await call(client, "get_transcription", { transcriptionId: TID, format: "summary", lang: "FR" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(only("GET", `/v1/transcriptions/${TID}/summary`)[0].query, { lang: "fr" });
  assert.deepEqual(r.structuredContent.summary, { lang: "fr", state: "ready", summary: "Résumé", title: "Titre" });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "summary" });
  assert.deepEqual(r.structuredContent.summary, { message: "No summary was asked for; update_transcription with summary true writes one.", state: "none" });
  assert.equal(only("POST", `/v1/transcriptions/${TID}/summarize`).length, 0);
});

test("get_transcription format summary: running, failed and short transcriptions", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  let r = await call(client, "get_transcription", { transcriptionId: TID, format: "summary" });
  assert.equal(r.structuredContent.summary.state, "pending");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("failed") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "unavailable" } });
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "summary" });
  assert.deepEqual(r.structuredContent.summary, { message: "The transcription failed, so there is nothing to summarise.", state: "unavailable" });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done", {}, { source: { kind: "url", name: "a.mp3", durationS: 30 } }) }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "summary" });
  assert.deepEqual(r.structuredContent.summary, { message: "Transcriptions shorter than a minute are not summarised.", state: "not_requested" });
});

test("update_transcription summary true writes one; a read-only key is refused; false is refused", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  fake.on("POST", `/v1/transcriptions/${TID}/summarize`, { body: { state: "pending" } });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  let r = await call(client, "update_transcription", { transcriptionId: TID, summary: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(r.structuredContent.summary, { message: "The summary is being written; ask again in a few seconds.", state: "pending" });
  assert.equal(only("POST", `/v1/transcriptions/${TID}/summarize`).length, 1);
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  fake.on("POST", `/v1/transcriptions/${TID}/summarize`, apiError(403, "forbidden", 'API key lacks the "write" scope', { requiredScope: ["write"] }));
  r = await call(client, "update_transcription", { transcriptionId: TID, summary: true });
  assert.equal(r.structuredContent.error, "forbidden");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  r = await call(client, "update_transcription", { transcriptionId: TID, summary: true });
  assert.equal(r.structuredContent.error, "invalid_state");
  fake.reset();
  r = await call(client, "update_transcription", { transcriptionId: TID, summary: false });
  assert.equal(r.content[0].text, "`summary` takes only true (write one now); a summary is never deleted");
  r = await call(client, "update_transcription", { transcriptionId: TID });
  assert.equal(r.content[0].text, "give at least one of `name`, `shareLink`, `summary`, `clonedVoices` or `restore` to change");
  assert.equal(fake.requests.length, 0);
});

test("update_transcription renames, shares and unshares", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PATCH", `/v1/transcriptions/${TID}`, { body: tx({ name: "Board call" }) });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  fake.on("POST", `/v1/transcriptions/${TID}/share-links`, { body: { id: "l1", url: "https://vocalstack.com/t/abc" } });
  let r = await call(client, "update_transcription", { transcriptionId: TID, name: "  Board call ", shareLink: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(only("PATCH", `/v1/transcriptions/${TID}`)[0].body, { name: "Board call" });
  assert.deepEqual(only("POST", `/v1/transcriptions/${TID}/share-links`)[0].body, { label: "Shared link" });
  assert.deepEqual(r.structuredContent, { clonedVoices: false, name: "Board call", shareUrl: "https://vocalstack.com/t/abc", transcriptionId: TID });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [{ id: "l1", url: "https://vocalstack.com/t/abc" }] } });
  fake.on("DELETE", "/v1/share-links/l1", { status: 204 });
  r = await call(client, "update_transcription", { transcriptionId: TID, shareLink: false });
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, "DELETE /v1/share-links/l1"]);
  assert.equal(r.structuredContent.shareUrl, null);
  fake.reset();
  r = await call(client, "update_transcription", { transcriptionId: TID, name: "é".repeat(201) });
  assert.match(r.content[0].text, /`name`/);
});

test("update_speaker puts the trimmed name on the speaker's number", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/2`, { body: { ok: true } });
  const r = await call(client, "update_speaker", { transcriptionId: TID.toUpperCase(), speaker: 2, name: "  Maria Lopez " });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `PUT /v1/transcriptions/${TID}/appearances/2`]);
  const put = fake.requests[1];
  assert.match(put.headers["content-type"], /^application\/json/);
  assert.deepEqual(put.body, { name: "Maria Lopez" });
  assert.deepEqual(r.structuredContent, { name: "Maria Lopez", speaker: 2, transcriptionId: TID });
});

test("update_speaker: an empty name clears it; a long one is cut to 80 characters", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/1`, { body: { ok: true } });
  let r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "   " });
  assert.deepEqual(fake.requests[1].body, { name: null });
  assert.deepEqual(r.structuredContent, { name: null, speaker: 1, transcriptionId: TID });
  fake.requests = [];
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "é".repeat(90) });
  assert.deepEqual(fake.requests[1].body, { name: "é".repeat(80) });
  assert.equal(r.structuredContent.name, "é".repeat(80));
});

test("update_speaker: a number the transcription lacks, an unknown transcription, bad arguments", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/7`, apiError(404, "not_found", "this transcription has no speaker 7"));
  let r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 7, name: "Ana" });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "This transcription has no Speaker 7; get_transcription shows the speaker numbers.");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(403, "forbidden", "not yours"));
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "Ana" });
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/1`, apiError(403, "forbidden", "this key lacks the write scope"));
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "Ana" });
  assert.equal(r.structuredContent.error, "forbidden");
  fake.reset();
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 0, name: "Ana" });
  assert.equal(r.content[0].text, "`speaker` must be an integer from 1 to 1000");
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1.5, name: "Ana" });
  assert.equal(r.content[0].text, "`speaker` must be an integer from 1 to 1000");
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: 3 });
  assert.equal(r.content[0].text, '`name` must be a string ("" clears the name)');
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1 });
  assert.equal(r.content[0].text, '`name` is required with `transcriptionId` and `speaker` ("" clears the name)');
  assert.equal(fake.requests.length, 0);
});

test("delete_transcription checks the transcription, archives it and returns when it can be restored", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("POST", `/v1/transcriptions/${TID}/archive`, {
    body: tx({ lifecycle: "archived", archivedAt: "2026-11-19T11:00:00Z", purgeAfter: "2026-12-19T11:00:00Z" }),
  });
  const r = await call(client, "delete_transcription", { transcriptionId: TID.toUpperCase() });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `POST /v1/transcriptions/${TID}/archive`]);
  assert.equal(fake.requests[1].body, undefined);
  assert.deepEqual(r.structuredContent, {
    deleted: true,
    deletedAt: "2026-11-19T11:00:00Z",
    name: "Episode 12",
    restorableUntil: "2026-12-19T11:00:00Z",
    transcriptionId: TID,
  });
});

test("delete_transcription refuses a live recording and a locked one, maps an unknown id, passes a read-only key's refusal", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("POST", `/v1/transcriptions/${TID}/archive`, apiError(409, "invalid_state", "stop the recording first"));
  let r = await call(client, "delete_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.structuredContent.status, 409);
  assert.equal(r.content[0].text, "This transcription is still recording live; stop it first (stop_broadcast for a broadcast), then delete it.");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("POST", `/v1/transcriptions/${TID}/archive`, apiError(409, "invalid_state", "this transcription is locked; unlock it before archiving it"));
  r = await call(client, "delete_transcription", { transcriptionId: TID });
  assert.equal(r.content[0].text, "this transcription is locked; unlock it before archiving it");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(404, "not_found", "transcription not found"));
  r = await call(client, "delete_transcription", { transcriptionId: TID });
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("POST", `/v1/transcriptions/${TID}/archive`, apiError(403, "forbidden", "this key lacks the write scope", { requiredScope: ["write"] }));
  r = await call(client, "delete_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.error, "forbidden");
  assert.deepEqual(r.structuredContent.details, { requiredScope: ["write"] });
});

test("update_transcription clonedVoices patches voiceCloning with the consent beside it", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PATCH", `/v1/transcriptions/${TID}`, { body: tx({ settings: { speakerLabels: "auto", voiceCloning: true } }) });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  let r = await call(client, "update_transcription", { transcriptionId: TID, clonedVoices: true, consent: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(only("PATCH", `/v1/transcriptions/${TID}`)[0].body, { settings: { voiceCloning: true, voiceCloningConsent: true } });
  assert.deepEqual(r.structuredContent, { clonedVoices: true, name: "Episode 12", shareUrl: null, transcriptionId: TID });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PATCH", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  r = await call(client, "update_transcription", { transcriptionId: TID, clonedVoices: false });
  assert.deepEqual(only("PATCH", `/v1/transcriptions/${TID}`)[0].body, { settings: { voiceCloning: false, voiceCloningConsent: false } });
  assert.equal(r.structuredContent.clonedVoices, false);
});

test("update_transcription clonedVoices: no consent, a deleted transcription, an unknown one, bad arguments", async () => {
  let r = await call(client, "update_transcription", { transcriptionId: TID, clonedVoices: true });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, "Turning cloned voices on needs consent: true, confirming everyone speaking agreed to have their voice cloned.");
  assert.equal(fake.requests.length, 0);
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ lifecycle: "archived" }) });
  r = await call(client, "update_transcription", { transcriptionId: TID, clonedVoices: true, consent: true });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.content[0].text, "This transcription is in the trash; pass restore: true to bring it back.");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(404, "not_found", "transcription not found"));
  r = await call(client, "update_transcription", { transcriptionId: TID, clonedVoices: false });
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  fake.reset();
  r = await call(client, "update_transcription", { transcriptionId: TID, clonedVoices: "yes" });
  assert.equal(r.content[0].text, "`clonedVoices` must be true or false");
  r = await call(client, "update_transcription", { transcriptionId: TID, clonedVoices: true, consent: "yes" });
  assert.equal(r.content[0].text, "`consent` must be true or false");
  r = await call(client, "update_transcription", { transcriptionId: TID, on: true });
  assert.match(r.content[0].text, /^unknown argument `on`/);
  assert.equal(fake.requests.length, 0);
});

test("list_speakers follows pages and says whether a clone is ready", async () => {
  fake.on("GET", "/v1/speakers", {
    body: {
      speakers: [{ id: "s1", name: "Ana", gender: "female", consent: "granted", voice: { id: "s1", state: "ready", enabled: true } }],
      nextCursor: "n1",
    },
  });
  fake.on("GET", "/v1/speakers", {
    body: { speakers: [{ id: "s2", name: "Bob", consent: "pending", voice: null }, { id: "s3", name: "Cy", consent: "pending", voice: { state: "ready", enabled: true } }] },
  });
  const r = await call(client, "list_speakers", {});
  assert.deepEqual(only("GET", "/v1/speakers").map((q) => q.query), [{}, { cursor: "n1" }]);
  assert.deepEqual(r.structuredContent.speakers, [
    { cloned: true, gender: "female", id: "s1", name: "Ana", voiceReady: true },
    { cloned: false, id: "s2", name: "Bob" },
    { cloned: true, id: "s3", name: "Cy", voiceReady: false },
  ]);
});

const saved = (extra = {}) => ({
  id: SPK,
  name: "Maria Lopez",
  draft: false,
  consent: "pending",
  library: true,
  createdAt: T0,
  updatedAt: T0,
  transcriptionId: TID,
  voice: null,
  ...extra,
});

test("update_speaker with save finds the speaker's number in the transcript and saves them from that appearance", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  fake.on("POST", "/v1/speakers/from-appearance", { status: 201, body: saved() });
  let r = await call(client, "update_speaker", { transcriptionId: TID.toUpperCase(), speaker: 2, name: "  Maria Lopez ", save: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `GET /v1/transcriptions/${TID}/transcript`, "GET /v1/speakers", "POST /v1/speakers/from-appearance"]);
  const post = only("POST", "/v1/speakers/from-appearance")[0];
  assert.match(post.headers["content-type"], /^application\/json/);
  assert.deepEqual(post.body, { transcriptionId: TID, appearance: 1, name: "Maria Lopez", consent: false });
  assert.deepEqual(r.structuredContent, { cloned: false, consent: "pending", name: "Maria Lopez", saved: true, speaker: 2, speakerId: SPK, transcriptionId: TID });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  fake.on("POST", "/v1/speakers/from-appearance", { status: 201, body: saved({ name: "Ana", consent: "granted", voice: { id: SPK, state: "training", progress: 0, enabled: true } }) });
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "Ana", consent: true, save: true });
  assert.deepEqual(only("POST", "/v1/speakers/from-appearance")[0].body, { transcriptionId: TID, appearance: 0, name: "Ana", consent: true });
  assert.deepEqual(r.structuredContent, { cloned: true, consent: "granted", name: "Ana", saved: true, speaker: 1, speakerId: SPK, transcriptionId: TID, voiceState: "training" });
});

test("update_speaker with save reads numbers as get_transcription shows them, with labels off and for speakers the server has not numbered", async () => {
  const snap = snapshot({ speakerLabels: "off", speakers: [{ speaker: 0, name: "Ana", number: 3 }] });
  snap.segments.push({ seq: 5, start: 90, end: 91, speaker: 4, text: "Late.", language: "en", words: [] });
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("live") });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snap });
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  fake.on("POST", "/v1/speakers/from-appearance", { status: 201, body: saved() });
  await call(client, "update_speaker", { transcriptionId: TID, speaker: 3, name: "Ana", save: true });
  assert.equal(only("POST", "/v1/speakers/from-appearance")[0].body.appearance, 0);
  await call(client, "update_speaker", { transcriptionId: TID, speaker: 4, name: "Bo", save: true });
  assert.equal(only("POST", "/v1/speakers/from-appearance")[1].body.appearance, 1);
  await call(client, "update_speaker", { transcriptionId: TID, speaker: 5, name: "Cy", save: true });
  assert.equal(only("POST", "/v1/speakers/from-appearance")[2].body.appearance, 4);
});

test("get_account reads the balance, plan, what would refuse a start and the limits", async () => {
  fake.on("GET", "/v1/billing", { body: { enabled: true, plan: { id: "payg", name: "Pay as you go", kind: "prepaid" }, balance: 12.5, canStart: true, startBlock: null, canStartLive: false, startBlockLive: "no_credit", limitsUsage: { running: 1, concurrentLimit: 3, createdLastHour: 2, createLimit: 60, resetsAt: null }, period: { start: "2026-11-01", end: "2026-12-01" }, topUpUrl: "https://vocalstack.com/app/billing" } });
  const r = await call(client, "get_account", {});
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), ["GET /v1/billing"]);
  assert.equal(r.structuredContent.balance, 12.5);
  assert.equal(r.structuredContent.startBlockLive, "no_credit");
  assert.equal(r.structuredContent.createLimit, 60);
  assert.equal(r.structuredContent.topUpUrl, "https://vocalstack.com/app/billing");
});

test("update_speaker with save: a number nobody spoke under, too little speech, an unknown transcription, bad arguments", async () => {
  const silent = snapshot({ speakers: [{ speaker: 0, name: "Ana", number: 1 }, { speaker: 1, name: "", number: 2 }, { speaker: 2, name: "", number: 3 }] });
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: silent });
  let r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 3, name: "Ana", save: true });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "This transcription has no Speaker 3 who has spoken; get_transcription shows the speaker numbers.");
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 9, name: "Ana", save: true });
  assert.equal(r.content[0].text, "This transcription has no Speaker 9 who has spoken; get_transcription shows the speaker numbers.");
  assert.equal(only("POST", "/v1/speakers/from-appearance").length, 0);
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  fake.on("POST", "/v1/speakers/from-appearance", apiError(400, "invalid_options", "cloning a voice needs at least 20 seconds of their speech; this speaker has 6.5"));
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 2, name: "Bo", consent: true, save: true });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, "cloning a voice needs at least 20 seconds of their speech; this speaker has 6.5");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  fake.on("POST", "/v1/speakers/from-appearance", apiError(404, "not_found", "speaker 1 has not said anything in this transcription"));
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 2, name: "Bo", save: true });
  assert.equal(r.content[0].text, "This transcription has no Speaker 2 who has spoken; get_transcription shows the speaker numbers.");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  fake.on("POST", "/v1/speakers/from-appearance", apiError(403, "forbidden", 'API key lacks the "write" scope', { requiredScope: ["write"] }));
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 2, name: "Bo", save: true });
  assert.equal(r.structuredContent.error, "forbidden");
  assert.deepEqual(r.structuredContent.details, { requiredScope: ["write"] });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(404, "not_found", "transcription not found"));
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "Ana", save: true });
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);
  fake.reset();
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "x".repeat(61), save: true });
  assert.equal(r.content[0].text, "`name` must be 1 to 60 characters");
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "   ", save: true });
  assert.equal(r.content[0].text, "`name` must be 1 to 60 characters");
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 0, name: "Ana", save: true });
  assert.equal(r.content[0].text, "`speaker` must be an integer from 1 to 1000");
  r = await call(client, "update_speaker", { transcriptionId: TID, speaker: 1, name: "Ana", consent: "yes", save: true });
  assert.equal(r.content[0].text, "`consent` must be true or false");
  r = await call(client, "update_speaker", { transcriptionId: TID, name: "Ana", save: true });
  assert.equal(r.content[0].text, "`speaker` is required with `transcriptionId`");
  assert.equal(fake.requests.length, 0);
});

test("delete_speaker deletes the saved speaker", async () => {
  fake.on("DELETE", `/v1/speakers/${SPK}`, { status: 204 });
  let r = await call(client, "delete_speaker", { speakerId: SPK.toUpperCase() });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`DELETE /v1/speakers/${SPK}`]);
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(fake.requests[0].body, undefined);
  assert.deepEqual(r.structuredContent, { deleted: true, speakerId: SPK });
  fake.reset();
  fake.on("DELETE", `/v1/speakers/${SPK}`, { body: { ok: true } });
  r = await call(client, "delete_speaker", { speakerId: SPK });
  assert.deepEqual(r.structuredContent, { deleted: true, speakerId: SPK });
});

test("delete_speaker: an unknown or someone else's id is not_found; a read-only key's refusal passes; bad arguments", async () => {
  fake.on("DELETE", `/v1/speakers/${SPK}`, apiError(404, "not_found", "speaker not found"));
  let r = await call(client, "delete_speaker", { speakerId: SPK });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No saved speaker with that id for this account; list_speakers shows them.");
  fake.reset();
  fake.on("DELETE", `/v1/speakers/${SPK}`, apiError(403, "forbidden", "not yours"));
  r = await call(client, "delete_speaker", { speakerId: SPK });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No saved speaker with that id for this account; list_speakers shows them.");
  fake.reset();
  fake.on("DELETE", `/v1/speakers/${SPK}`, apiError(403, "forbidden", 'API key lacks the "write" scope', { requiredScope: ["write"] }));
  r = await call(client, "delete_speaker", { speakerId: SPK });
  assert.equal(r.structuredContent.error, "forbidden");
  assert.equal(r.content[0].text, 'API key lacks the "write" scope');
  fake.reset();
  r = await call(client, "delete_speaker", { speakerId: "s1" });
  assert.equal(r.content[0].text, "`speakerId` must be a UUID");
  r = await call(client, "delete_speaker", {});
  assert.equal(r.content[0].text, "`speakerId` is required");
  r = await call(client, "delete_speaker", { id: SPK });
  assert.equal(r.content[0].text, "unknown argument `id`; this tool takes speakerId");
  assert.equal(fake.requests.length, 0);
});

test("list_broadcasts lists them; with broadcastId it returns that one in detail as the only item", async () => {
  const live = bcast({
    currentTranscription: { transcriptionId: TID, state: "live", startedAt: T0 },
    lastRecordedAt: T0,
    audioSources: [{ id: SRC, name: "Radio", url: "https://radio.example/live.m3u8" }],
    transcriptions: Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, name: `Take ${i}`, recording: i === 0, lastRecordedAt: i === 0 ? T0 : null })),
  });
  fake.on("GET", "/v1/broadcasts", { body: { broadcasts: [live, bcast({ id: "b2", lifecycle: "archived", listenersNow: null })] } });
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: live });
  const l = await call(client, "list_broadcasts", { lifecycle: "all" });
  assert.deepEqual(only("GET", "/v1/broadcasts")[0].query, { lifecycle: "all" });
  const first = { access: "public", broadcastId: BID, lastRecordedAt: T0, link: "https://vocalstack.com/sunday", listenersNow: 3, name: "Sunday service", onAir: true, onAirSince: T0, state: "live", transcriptionId: TID };
  assert.deepEqual(l.structuredContent.broadcasts, [
    first,
    { access: "public", archived: true, broadcastId: "b2", link: "https://vocalstack.com/sunday", listenersNow: 0, name: "Sunday service", onAir: false },
  ]);
  fake.requests = [];
  const g = await call(client, "list_broadcasts", { broadcastId: BID.toUpperCase(), lifecycle: "archived" });
  assert.deepEqual(seen(), [`GET /v1/broadcasts/${BID}`], "lifecycle is ignored with broadcastId");
  assert.equal(g.structuredContent.broadcasts.length, 1);
  const [one] = g.structuredContent.broadcasts;
  const { transcriptions, streams, ...head } = one;
  assert.deepEqual(head, first);
  assert.equal(transcriptions.length, 20);
  assert.deepEqual(transcriptions[0], { lastRecordedAt: T0, name: "Take 0", recording: true, transcriptionId: "t0" });
  assert.deepEqual(transcriptions[1], { name: "Take 1", recording: false, transcriptionId: "t1" });
  assert.deepEqual(streams, [{ name: "Radio", url: "https://radio.example/live.m3u8" }]);
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast() });
  const empty = await call(client, "list_broadcasts", { broadcastId: BID });
  assert.deepEqual(empty.structuredContent.broadcasts[0].transcriptions, []);
  assert.deepEqual(empty.structuredContent.broadcasts[0].streams, []);
});

test("list_broadcasts: an unknown broadcastId, a bad one, a bad lifecycle", async () => {
  fake.on("GET", `/v1/broadcasts/${BID}`, apiError(404, "not_found", "nope"));
  let r = await call(client, "list_broadcasts", { broadcastId: BID });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No broadcast with that id for this account.");
  fake.reset();
  r = await call(client, "list_broadcasts", { broadcastId: "b2" });
  assert.equal(r.content[0].text, "`broadcastId` must be a UUID");
  r = await call(client, "list_broadcasts", { lifecycle: "gone" });
  assert.equal(r.content[0].text, "`lifecycle` must be one of active, archived, all");
  assert.equal(fake.requests.length, 0);
  fake.on("GET", "/v1/broadcasts", { body: { broadcasts: [] } });
  r = await call(client, "list_broadcasts", { broadcastId: "  " });
  assert.deepEqual(r.structuredContent, { broadcasts: [] }, "a blank broadcastId lists them");
  assert.deepEqual(only("GET", "/v1/broadcasts")[0].query, { lifecycle: "active" });
});

const STREAM = "https://www.radio.example/live.m3u8";
const grant = (state = "live") => ({ transcription: { ...liveTx(state), id: TID } });

test("start_broadcast makes a broadcast named after the host, adds the stream and records it", async () => {
  fake.on("POST", "/v1/broadcasts", { status: 201, body: bcast() });
  fake.on("POST", `/v1/broadcasts/${BID}/audio-sources`, { status: 201, body: bcast({ audioSources: [{ id: SRC, name: "radio.example", url: STREAM }] }) });
  fake.on("POST", `/v1/broadcasts/${BID}/record`, { status: 201, body: grant() });
  const r = await call(client, "start_broadcast", { streamUrl: STREAM, spokenLanguage: "EN", spokenTranslations: true, idempotencyKey: "sun-1" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), ["POST /v1/broadcasts", `POST /v1/broadcasts/${BID}/audio-sources`, `POST /v1/broadcasts/${BID}/record`]);
  const [create] = only("POST", "/v1/broadcasts");
  assert.deepEqual(create.body, { name: "radio.example" });
  assert.equal(create.headers["idempotency-key"], "sun-1:broadcast");
  assert.deepEqual(only("POST", `/v1/broadcasts/${BID}/audio-sources`)[0].body, { url: STREAM });
  const [rec] = only("POST", `/v1/broadcasts/${BID}/record`);
  assert.deepEqual(rec.body, { audioSource: SRC, settings: { spokenLanguage: "en", translationTts: true } });
  assert.equal(rec.headers["idempotency-key"], "sun-1:record");
  assert.deepEqual(r.structuredContent, {
    broadcastId: BID,
    link: "https://vocalstack.com/sunday",
    message:
      "Share the link: anyone who opens it picks a language and reads (or hears) the stream in it as it plays. Read the transcript with get_transcription; stop it with stop_broadcast.",
    name: "Sunday service",
    state: "live",
    transcriptionId: TID,
  });
});

test("start_broadcast on an existing broadcast reuses its stream; refuses one on air", async () => {
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ audioSources: [{ id: SRC, name: "r", url: STREAM }] }) });
  fake.on("POST", `/v1/broadcasts/${BID}/record`, { status: 201, body: grant("pending") });
  let r = await call(client, "start_broadcast", { streamUrl: STREAM, broadcastId: BID, name: "ignored" });
  assert.deepEqual(seen(), [`GET /v1/broadcasts/${BID}`, `POST /v1/broadcasts/${BID}/record`]);
  assert.deepEqual(only("POST", `/v1/broadcasts/${BID}/record`)[0].body, { audioSource: SRC });
  assert.equal(only("POST", `/v1/broadcasts/${BID}/record`)[0].headers["idempotency-key"], undefined);
  assert.equal(r.structuredContent.state, "pending");
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ currentTranscription: { transcriptionId: TID, state: "live" } }) });
  r = await call(client, "start_broadcast", { streamUrl: STREAM, broadcastId: BID });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "This broadcast is already on air; stop it first (stop_broadcast) or use another broadcast.");
  assert.deepEqual(r.structuredContent.details, { broadcastId: BID, link: "https://vocalstack.com/sunday" });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.deepEqual(seen(), [`GET /v1/broadcasts/${BID}`]);
  r = await call(client, "start_broadcast", { streamUrl: "ftp://x.example/a" });
  assert.equal(r.content[0].text, "`streamUrl` must be an http(s) address");
  r = await call(client, "start_broadcast", { streamUrl: STREAM, broadcastId: "b2" });
  assert.equal(r.content[0].text, "`broadcastId` must be a UUID");
});

test("start_broadcast retried with its key replays instead of starting twice", async () => {
  fake.on("POST", "/v1/broadcasts", { status: 201, body: bcast(), headers: { "idempotent-replayed": "true" } });
  fake.on("GET", `/v1/broadcasts/${BID}`, {
    body: bcast({ audioSources: [{ id: SRC, name: "r", url: STREAM }], currentTranscription: { transcriptionId: TID, state: "live" } }),
  });
  fake.on("POST", `/v1/broadcasts/${BID}/record`, { status: 201, body: grant(), headers: { "idempotent-replayed": "true" } });
  const r = await call(client, "start_broadcast", { streamUrl: STREAM, idempotencyKey: "sun-1" });
  assert.deepEqual(seen(), ["POST /v1/broadcasts", `GET /v1/broadcasts/${BID}`, `POST /v1/broadcasts/${BID}/record`]);
  assert.equal(r.structuredContent.replayed, true);
  assert.equal(r.structuredContent.transcriptionId, TID);
});

test("stop_broadcast pauses a live transcription, then stops it", async () => {
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ currentTranscription: { transcriptionId: TID, state: "live" } }) });
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("live") });
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("processing", { endedAt: "2026-11-19T11:00:00Z" }) });
  fake.on("POST", `/v1/transcriptions/${TID}/pause`, { body: liveTx("paused") });
  fake.on("POST", `/v1/transcriptions/${TID}/stop`, { body: liveTx("processing") });
  const r = await call(client, "stop_broadcast", { broadcastId: BID });
  assert.deepEqual(seen(), [
    `GET /v1/broadcasts/${BID}`,
    `GET /v1/transcriptions/${TID}`,
    `POST /v1/transcriptions/${TID}/pause`,
    `POST /v1/transcriptions/${TID}/stop`,
    `GET /v1/transcriptions/${TID}`,
  ]);
  assert.deepEqual(only("POST", `/v1/transcriptions/${TID}/stop`)[0].body, {});
  assert.deepEqual(r.structuredContent, {
    broadcastId: BID,
    createdAt: T0,
    durationS: 30,
    endedAt: "2026-11-19T11:00:00Z",
    kind: "live",
    link: "https://vocalstack.com/sunday",
    name: "Episode 12",
    spokenLanguage: "en",
    startedAt: "2026-11-19T10:01:00Z",
    state: "finishing",
    transcriptionId: TID,
  });
});

test("stop_broadcast: paused skips the pause; not on air is invalid_state", async () => {
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ currentTranscription: { transcriptionId: TID, state: "paused" } }) });
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("paused") });
  fake.on("POST", `/v1/transcriptions/${TID}/stop`, { body: liveTx("processing") });
  await call(client, "stop_broadcast", { broadcastId: BID });
  assert.equal(only("POST", `/v1/transcriptions/${TID}/pause`).length, 0);
  assert.equal(only("POST", `/v1/transcriptions/${TID}/stop`).length, 1);
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ currentTranscription: { transcriptionId: TID, state: "finalized" } }) });
  const r = await call(client, "stop_broadcast", { broadcastId: BID });
  assert.equal(r.content[0].text, "This broadcast is not on air.");
  assert.deepEqual(r.structuredContent.details, { broadcastId: BID });
  assert.equal(r.structuredContent.status, 409);
});

test("get_transcription: the status carries shareUrl when the transcription has a share link, and nothing when the lookup fails", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [{ url: "https://vocalstack.com/t/abc" }, { url: "https://vocalstack.com/t/def" }] } });
  let r = await call(client, "get_transcription", { transcriptionId: TID, format: "none" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(only("GET", `/v1/transcriptions/${TID}/share-links`).length, 1);
  assert.equal(r.structuredContent.status.shareUrl, "https://vocalstack.com/t/abc");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "none" });
  assert.equal(r.structuredContent.status.shareUrl, undefined);
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, apiError(500, "internal", "boom"));
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "none" });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.status.shareUrl, undefined);
});

test("update_speaker with speakerId renames the saved speaker", async () => {
  fake.on("PATCH", `/v1/speakers/${SPK}`, { body: saved({ name: "Maria L." }) });
  const r = await call(client, "update_speaker", { speakerId: SPK.toUpperCase(), name: "  Maria L. " });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`PATCH /v1/speakers/${SPK}`]);
  assert.deepEqual(fake.requests[0].body, { name: "Maria L." });
  assert.deepEqual(r.structuredContent, { clonedVoice: false, consent: "pending", name: "Maria L.", speakerId: SPK });
});

test("update_speaker: exactly one target; a saved speaker's name is 1 to 60; unknown and read-only", async () => {
  const msg = async (args) => (await call(client, "update_speaker", args)).content[0].text;
  assert.equal(await msg({ speakerId: SPK, speaker: 2, name: "A" }), "give either `speakerId` (a saved speaker) or `transcriptionId` with `speaker`, not both");
  assert.equal(await msg({ speakerId: SPK, transcriptionId: TID, name: "A" }), "give either `speakerId` (a saved speaker) or `transcriptionId` with `speaker`, not both");
  assert.equal(await msg({ transcriptionId: TID, name: "A" }), "`speaker` is required with `transcriptionId`");
  assert.equal(await msg({ speaker: 2, name: "A" }), "`transcriptionId` is required with `speaker`");
  assert.equal(await msg({ name: "A" }), "give `transcriptionId` with `speaker` (one transcription) or `speakerId` (a saved speaker)");
  assert.equal(await msg({ speakerId: SPK }), "give `name`, `clonedVoice` or both to change a saved speaker");
  assert.equal(await msg({ speakerId: SPK, name: "   " }), "a saved speaker's `name` must be 1 to 60 characters");
  assert.equal(await msg({ speakerId: SPK, name: "é".repeat(61) }), "a saved speaker's `name` must be 1 to 60 characters");
  assert.equal(await msg({ speakerId: SPK, name: 3 }), "`name` must be a string");
  assert.equal(await msg({ speakerId: "s1", name: "A" }), "`speakerId` must be a UUID");
  assert.equal(fake.requests.length, 0);
  fake.on("PATCH", `/v1/speakers/${SPK}`, apiError(404, "not_found", "speaker not found"));
  let r = await call(client, "update_speaker", { speakerId: SPK, name: "A" });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No saved speaker with that id for this account; list_speakers shows them.");
  fake.reset();
  fake.on("PATCH", `/v1/speakers/${SPK}`, apiError(403, "forbidden", "not yours"));
  r = await call(client, "update_speaker", { speakerId: SPK, name: "A" });
  assert.equal(r.content[0].text, "No saved speaker with that id for this account; list_speakers shows them.");
  fake.reset();
  fake.on("PATCH", `/v1/speakers/${SPK}`, apiError(403, "forbidden", 'API key lacks the "write" scope', { requiredScope: ["write"] }));
  r = await call(client, "update_speaker", { speakerId: SPK, name: "A" });
  assert.equal(r.structuredContent.error, "forbidden");
  assert.deepEqual(r.structuredContent.details, { requiredScope: ["write"] });
});

test("update_speaker clonedVoice on: grants consent, switches a disabled clone on, reports the speaker", async () => {
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved() });
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved({ consent: "granted", voice: { id: SPK, state: "training", enabled: true } }) });
  fake.on("POST", `/v1/speakers/${SPK}/consent`, { body: saved({ consent: "granted", voice: { id: SPK, state: "training", enabled: true } }) });
  let r = await call(client, "update_speaker", { speakerId: SPK.toUpperCase(), clonedVoice: true, consent: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/speakers/${SPK}`, `POST /v1/speakers/${SPK}/consent`, `GET /v1/speakers/${SPK}`]);
  assert.deepEqual(only("POST", `/v1/speakers/${SPK}/consent`)[0].body, { consent: "granted" });
  assert.deepEqual(r.structuredContent, { clonedVoice: true, consent: "granted", name: "Maria Lopez", speakerId: SPK, voiceState: "training" });
  fake.reset();
  const off = { id: SPK, state: "ready", enabled: false };
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved({ consent: "granted", voice: off }) });
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved({ consent: "granted", voice: { ...off, enabled: true } }) });
  fake.on("POST", `/v1/speakers/${SPK}/consent`, { body: saved({ consent: "granted", voice: off }) });
  fake.on("PATCH", `/v1/speakers/${SPK}`, { body: saved({ consent: "granted", voice: { ...off, enabled: true } }) });
  r = await call(client, "update_speaker", { speakerId: SPK, clonedVoice: true, consent: true });
  assert.deepEqual(seen(), [`GET /v1/speakers/${SPK}`, `POST /v1/speakers/${SPK}/consent`, `PATCH /v1/speakers/${SPK}`, `GET /v1/speakers/${SPK}`]);
  assert.deepEqual(only("PATCH", `/v1/speakers/${SPK}`)[0].body, { enabled: true });
  assert.deepEqual(r.structuredContent, { clonedVoice: true, consent: "granted", name: "Maria Lopez", speakerId: SPK, voiceState: "ready" });
});

test("update_speaker clonedVoice off: switches the clone off and keeps it; nothing to switch sends no patch", async () => {
  const on = { id: SPK, state: "ready", enabled: true };
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved({ consent: "granted", voice: on }) });
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved({ consent: "granted", voice: { ...on, enabled: false } }) });
  fake.on("PATCH", `/v1/speakers/${SPK}`, { body: saved({ consent: "granted", voice: { ...on, enabled: false } }) });
  let r = await call(client, "update_speaker", { speakerId: SPK, clonedVoice: false });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/speakers/${SPK}`, `PATCH /v1/speakers/${SPK}`, `GET /v1/speakers/${SPK}`]);
  assert.deepEqual(only("PATCH", `/v1/speakers/${SPK}`)[0].body, { enabled: false });
  assert.deepEqual(r.structuredContent, { clonedVoice: false, consent: "granted", name: "Maria Lopez", speakerId: SPK, voiceState: "ready" });
  fake.reset();
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved() });
  r = await call(client, "update_speaker", { speakerId: SPK, clonedVoice: false, transcriptionId: null });
  assert.deepEqual(seen(), [`GET /v1/speakers/${SPK}`, `GET /v1/speakers/${SPK}`]);
  assert.deepEqual(r.structuredContent, { clonedVoice: false, consent: "pending", name: "Maria Lopez", speakerId: SPK });
});

test("update_speaker clonedVoice: exactly one target, consent, a refused speaker, no sample, unknown", async () => {
  const msg = async (args) => (await call(client, "update_speaker", args)).content[0].text;
  assert.equal(await msg({ speakerId: SPK, transcriptionId: TID, clonedVoice: false }), "give either `speakerId` (a saved speaker) or `transcriptionId` with `speaker`, not both");
  assert.equal(await msg({ clonedVoice: true, consent: true }), "give `transcriptionId` with `speaker` (one transcription) or `speakerId` (a saved speaker)");
  assert.equal(await msg({ transcriptionId: TID, speaker: 1, clonedVoice: true, consent: true }), "`clonedVoice` is for a saved speaker (speakerId); for everyone in one transcription use update_transcription with clonedVoices");
  assert.equal(
    await msg({ speakerId: SPK, clonedVoice: true }),
    "Turning a saved speaker's cloned voice on needs consent: true, confirming that person agreed to have their voice cloned.",
  );
  assert.equal(await msg({ speakerId: SPK, clonedVoice: "yes" }), "`clonedVoice` must be true or false");
  assert.equal(await msg({ speakerId: "s1", clonedVoice: false }), "`speakerId` must be a UUID");
  assert.equal(fake.requests.length, 0);
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved({ consent: "refused" }) });
  let r = await call(client, "update_speaker", { speakerId: SPK, clonedVoice: true, consent: true });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(
    r.content[0].text,
    "This speaker refused to be cloned and their audio was deleted; save them again from a transcription (update_speaker with save and consent) to clone them.",
  );
  assert.deepEqual(seen(), [`GET /v1/speakers/${SPK}`]);
  fake.reset();
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved() });
  fake.on(
    "POST",
    `/v1/speakers/${SPK}/consent`,
    apiError(409, "invalid_state", "this speaker has no sample stored to clone their voice from: save them again from a sample or a transcription"),
  );
  r = await call(client, "update_speaker", { speakerId: SPK, clonedVoice: true, consent: true });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.content[0].text, "This saved speaker has no stored sample to clone their voice from; save them again from a transcription (update_speaker with save and consent).");
  fake.reset();
  fake.on("GET", `/v1/speakers/${SPK}`, apiError(404, "not_found", "speaker not found"));
  r = await call(client, "update_speaker", { speakerId: SPK, clonedVoice: false });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No saved speaker with that id for this account; list_speakers shows them.");
  fake.reset();
  fake.on("GET", `/v1/speakers/${SPK}`, { body: saved() });
  fake.on("POST", `/v1/speakers/${SPK}/consent`, apiError(403, "forbidden", 'API key lacks the "write" scope', { requiredScope: ["write"] }));
  r = await call(client, "update_speaker", { speakerId: SPK, clonedVoice: true, consent: true });
  assert.equal(r.structuredContent.error, "forbidden");
  assert.deepEqual(r.structuredContent.details, { requiredScope: ["write"] });
});

test("update_transcription and update_broadcast restore true bring one back from the trash", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ lifecycle: "archived" }) });
  fake.on("POST", `/v1/transcriptions/${TID}/restore`, { body: tx() });
  fake.on("PATCH", `/v1/transcriptions/${TID}`, { body: tx({ name: "Back" }) });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  let r = await call(client, "update_transcription", { transcriptionId: TID, restore: true, name: "Back" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(only("POST", `/v1/transcriptions/${TID}/restore`).length, 1);
  assert.equal(r.structuredContent.restored, true);
  assert.equal(r.structuredContent.name, "Back");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [] } });
  r = await call(client, "update_transcription", { transcriptionId: TID, restore: true });
  assert.equal(r.structuredContent.restored, false);
  assert.equal(only("POST", `/v1/transcriptions/${TID}/restore`).length, 0);
  fake.reset();
  r = await call(client, "update_transcription", { transcriptionId: TID, restore: false });
  assert.equal(r.structuredContent.error, "invalid_options");
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ lifecycle: "archived" }) });
  fake.on("POST", `/v1/broadcasts/${BID}/restore`, { body: bcast() });
  r = await call(client, "update_broadcast", { broadcastId: BID, restore: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(only("POST", `/v1/broadcasts/${BID}/restore`).length, 1);
  assert.equal(only("PATCH", `/v1/broadcasts/${BID}`).length, 0);
  assert.equal(r.structuredContent.restored, true);
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ lifecycle: "archived" }) });
  fake.on("PATCH", `/v1/broadcasts/${BID}`, apiError(409, "invalid_state", "broadcast is archived"));
  r = await call(client, "update_broadcast", { broadcastId: BID, name: "Back" });
  assert.equal(r.content[0].text, "This broadcast is in the trash; pass restore: true to bring it back.");
});

test("update_broadcast patches name, access and settings; going private makes a listener code, returned once", async () => {
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast() });
  fake.on("PATCH", `/v1/broadcasts/${BID}`, apiError(400, "invalid_options", "private broadcasts need a password"));
  fake.on("PATCH", `/v1/broadcasts/${BID}`, {
    body: bcast({ name: "Town hall", access: "private", settings: { spokenLanguage: "es", translationTts: true, voiceCloning: true } }),
  });
  let r = await call(client, "update_broadcast", {
    broadcastId: BID,
    name: "Town hall",
    access: "private",
    spokenLanguage: "ES",
    spokenTranslations: true,
    clonedVoices: true,
    consent: true,
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const patches = only("PATCH", `/v1/broadcasts/${BID}`);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].body.password, undefined);
  assert.match(patches[1].body.password, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal(r.structuredContent.listenerCode, patches[1].body.password);
  assert.equal(r.structuredContent.access, "private");
  assert.equal(r.structuredContent.spokenLanguage, "es");
  assert.equal(r.structuredContent.spokenTranslations, true);
  assert.equal(r.structuredContent.clonedVoices, true);
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast() });
  fake.on("PATCH", `/v1/broadcasts/${BID}`, { body: bcast() });
  r = await call(client, "update_broadcast", { broadcastId: BID, access: "public", spokenLanguage: "auto" });
  assert.deepEqual(only("PATCH", `/v1/broadcasts/${BID}`)[0].body, { access: "public", settings: { spokenLanguage: null } });
  assert.equal(r.structuredContent.spokenLanguage, "auto");
  assert.equal(r.structuredContent.listenerCode, undefined);
  r = await call(client, "update_broadcast", { broadcastId: BID, newListenerCode: true });
  assert.match(r.content[0].text, /is for a private broadcast/);
  fake.reset();
  r = await call(client, "update_broadcast", { broadcastId: BID });
  assert.match(r.content[0].text, /^give at least one of/);
  r = await call(client, "update_broadcast", { broadcastId: BID, clonedVoices: true });
  assert.equal(r.content[0].text, "Turning cloned voices on needs consent: true, confirming everyone speaking agreed to have their voice cloned.");
  assert.equal(fake.requests.length, 0);
});

test("delete_broadcast checks the broadcast, archives it and returns when it can be restored", async () => {
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast() });
  fake.on("POST", `/v1/broadcasts/${BID}/archive`, {
    body: bcast({ lifecycle: "archived", archivedAt: "2026-11-19T11:00:00Z", purgeAfter: "2026-12-19T11:00:00Z" }),
  });
  const r = await call(client, "delete_broadcast", { broadcastId: BID.toUpperCase() });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/broadcasts/${BID}`, `POST /v1/broadcasts/${BID}/archive`]);
  assert.equal(fake.requests[1].body, undefined);
  assert.deepEqual(r.structuredContent, {
    broadcastId: BID,
    deleted: true,
    deletedAt: "2026-11-19T11:00:00Z",
    name: "Sunday service",
    restorableUntil: "2026-12-19T11:00:00Z",
  });
});

test("delete_broadcast: on air is refused with the hosted wording; unknown, read-only, bad arguments", async () => {
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast({ currentTranscription: { transcriptionId: TID, state: "live" } }) });
  fake.on("POST", `/v1/broadcasts/${BID}/archive`, apiError(409, "invalid_state", "stop the recording first"));
  let r = await call(client, "delete_broadcast", { broadcastId: BID });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.structuredContent.status, 409);
  assert.equal(r.content[0].text, "This broadcast is on air; stop it first (stop_broadcast), then delete it.");
  assert.deepEqual(r.structuredContent.details, { broadcastId: BID });
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, apiError(404, "not_found", "broadcast not found"));
  r = await call(client, "delete_broadcast", { broadcastId: BID });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No broadcast with that id for this account.");
  assert.deepEqual(seen(), [`GET /v1/broadcasts/${BID}`]);
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, { body: bcast() });
  fake.on("POST", `/v1/broadcasts/${BID}/archive`, apiError(403, "forbidden", 'API key lacks the "write" scope', { requiredScope: ["write"] }));
  r = await call(client, "delete_broadcast", { broadcastId: BID });
  assert.equal(r.structuredContent.error, "forbidden");
  assert.deepEqual(r.structuredContent.details, { requiredScope: ["write"] });
  fake.reset();
  r = await call(client, "delete_broadcast", { broadcastId: "b1" });
  assert.equal(r.content[0].text, "`broadcastId` must be a UUID");
  r = await call(client, "delete_broadcast", {});
  assert.equal(r.content[0].text, "`broadcastId` is required");
  r = await call(client, "delete_broadcast", { broadcastId: BID, transcriptionId: TID });
  assert.equal(r.content[0].text, "unknown argument `transcriptionId`; this tool takes broadcastId");
  assert.equal(fake.requests.length, 0);
});

test("API errors become tool errors with code, plain message, retryable, retryAfterS and topUpUrl", async () => {
  fake.on("POST", "/v1/transcriptions", apiError(402, "insufficient_credit", "Not enough credit.", { balance: 0, required: 5 }));
  let r = await call(client, "create_transcription", { url: "https://example.com/a.mp3" });
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent, {
    details: { balance: 0, required: 5 },
    error: "insufficient_credit",
    message: "Not enough credit.",
    retryAfterS: null,
    retryable: false,
    status: 402,
    topUpUrl: "https://app.vocalstack.com/billing",
  });
  assert.equal(
    r.content[0].text,
    "Not enough credit. The account has not enough credit to start this (a new transcription needs more than its minimum charge costs); add credit before trying again.",
  );
  fake.reset();
  fake.on("POST", "/v1/transcriptions", apiError(422, "idempotency_key_reused", "this Idempotency-Key was used with a different request"));
  r = await call(client, "create_transcription", { url: "https://example.com/a.mp3", idempotencyKey: "k" });
  assert.equal(r.structuredContent.error, "idempotency_key_reused");
  assert.equal(r.structuredContent.status, 422);
  fake.reset();
  fake.on("GET", "/v1/speakers", apiError(429, "rate_limited", "Too many calls", { retryAfterS: 7 }, true));
  r = await call(client, "list_speakers", {});
  assert.equal(r.content[0].text, "Too many calls. Wait 7 seconds before trying again.");
  assert.equal(r.structuredContent.retryable, true);
  assert.equal(r.structuredContent.retryAfterS, 7);
  fake.reset();
  fake.on("GET", "/v1/speakers", apiError(500, "internal", "db: secret detail"));
  r = await call(client, "list_speakers", {});
  assert.equal(r.content[0].text, "Something went wrong on the server.");
  assert.equal(r.structuredContent.error, "internal");
  fake.reset();
  fake.on("GET", "/v1/speakers", { status: 502, body: "bad gateway" });
  r = await call(client, "list_speakers", {});
  assert.equal(r.structuredContent.error, "unavailable");
  assert.equal(r.structuredContent.retryable, true);
});

test("a 401 says the key was refused", async () => {
  fake.on("GET", "/v1/speakers", apiError(401, "invalid_token", "invalid API key"));
  const r = await call(client, "list_speakers", {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^The API key was refused\./);
  assert.equal(r.structuredContent.error, "invalid_token");
});

test("an unreachable API is unavailable and retryable", async () => {
  const c = await connect({ url: "http://127.0.0.1:9" });
  try {
    const r = await call(c, "list_speakers", {});
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error, "unavailable");
    assert.equal(r.structuredContent.retryable, true);
    assert.match(r.content[0].text, /^Could not reach VocalStack/);
  } finally {
    await c.close();
  }
});

test("when the language list cannot be read, lang is left to the API to refuse", async () => {
  const other = new FakeApi();
  await other.start();
  const c = await connect(other);
  try {
    other.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
    other.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
    other.on("GET", `/v1/transcriptions/${TID}/translation`, apiError(400, "invalid_options", "lang is not a translation target"));
    const r = await call(c, "get_transcription", { transcriptionId: TID, lang: "xx" });
    assert.equal(r.structuredContent.error, "invalid_options");
    assert.equal(r.content[0].text, '`lang` "xx" is not a language this API translates into');
    assert.deepEqual(
      other.requests.map((q) => `${q.method} ${q.path}`),
      ["GET /v1/languages", `GET /v1/transcriptions/${TID}`, `GET /v1/transcriptions/${TID}/share-links`, `GET /v1/transcriptions/${TID}/transcript`, `GET /v1/transcriptions/${TID}/translation`],
    );
  } finally {
    await c.close();
    await other.stop();
  }
});

test("without a key: initialize and tools/list work, every call asks for the key, nothing is requested", async () => {
  const c = await connect(fake, null);
  try {
    assert.equal(c.getInstructions(), DEFS.instructions);
    const { tools } = await c.listTools();
    assert.deepEqual(tools, DEFS.tools);
    for (const t of DEFS.tools) {
      const r = await call(c, t.name, {});
      assert.equal(r.isError, true);
      assert.deepEqual(r.content, [
        { type: "text", text: "Set VOCALSTACK_API_KEY to an API key from https://app.vocalstack.com (Developers → API keys)." },
      ]);
    }
  } finally {
    await c.close();
  }
  assert.equal(fake.requests.length, 0);
});

test("VOCALSTACK_API_URL may carry a trailing slash", async () => {
  const c = await connect({ url: `${fake.url}/` });
  try {
    fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
    const r = await call(c, "list_speakers", {});
    assert.deepEqual(r.structuredContent, { speakers: [] });
  } finally {
    await c.close();
  }
});

test("the language list is read once per server and kept", () => {
  assert.equal(languageCalls, 1);
});
