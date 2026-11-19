import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeApi, apiError, connect, call, KEY, DEFS, VERSION } from "./helpers.mjs";

const TID = "0190f0e0-7c1a-7d3e-9b2a-5f4e3d2c1b0a";
const BID = "0190f0e0-0000-7000-8000-00000000000b";
const SRC = "0190f0e0-0000-7000-8000-0000000000aa";
const T0 = "2026-11-19T10:00:00Z";

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
  spokenLanguage: "en",
  settings: { speakerLabels: "auto" },
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

before(async () => {
  await fake.start();
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
  return fake.requests.map((r) => `${r.method} ${r.path}`);
}

test("initialize carries the stored instructions and this package's version", () => {
  assert.deepEqual(client.getServerVersion(), { name: "vocalstack", version: VERSION });
  assert.equal(client.getInstructions(), DEFS.instructions);
  assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: false });
});

test("tools/list is exactly tools.json", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools, DEFS.tools);
  assert.equal(tools.length, 18);
});

test("every request carries the key, the user agent and asks for JSON", async () => {
  fake.on("GET", "/v1/speakers", { body: { speakers: [] } });
  await call(client, "list_speakers", {});
  const r = fake.requests[0];
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.headers["user-agent"], `vocalstack-mcp/${VERSION}`);
  assert.equal(r.headers.accept, "application/json");
});

test("an unknown tool is a protocol error", async () => {
  await assert.rejects(call(client, "nope", {}), (e) => {
    assert.equal(e.code, -32602);
    assert.match(e.message, /unknown tool "nope"/);
    return true;
  });
});

test("arguments are held to the schema, worded as the hosted server words them", async () => {
  let r = await call(client, "get_transcription", { transcriptionId: TID, bogus: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, "unknown argument `bogus`; this tool takes format, includeWords, limit, offset, transcriptionId");
  r = await call(client, "get_transcription", {});
  assert.equal(r.content[0].text, "`transcriptionId` is required");
  r = await call(client, "get_transcription", { transcriptionId: "x" });
  assert.equal(r.content[0].text, "`transcriptionId` must be a UUID");
  r = await call(client, "get_transcription", { transcriptionId: TID, limit: 0 });
  assert.equal(r.content[0].text, "`limit` must be an integer from 1 to 2000");
  r = await call(client, "get_transcription", { transcriptionId: TID, format: "pdf" });
  assert.equal(r.content[0].text, "`format` must be one of text, segments, none");
  r = await call(client, "transcribe_url", { url: "https://x", shareLink: "yes" });
  assert.equal(r.content[0].text, "`shareLink` must be true or false");
  r = await call(client, "search_transcriptions", { query: "a" });
  assert.equal(r.content[0].text, "`query` must be 2 to 200 characters");
  r = await call(client, "transcribe_url", { url: "https://x", idempotencyKey: "has space" });
  assert.equal(r.content[0].text, "idempotencyKey must be 1 to 255 visible ASCII characters");
  assert.equal(fake.requests.length, 0);
});

test("transcribe_url posts the link and options, with the idempotency key, and returns the status", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx() });
  fake.on("GET", `/v1/transcriptions/${TID}/share-links`, { body: { links: [{ url: "https://vocalstack.com/t/abc" }] } });
  const r = await call(client, "transcribe_url", {
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
    next: "Call wait_for_transcription with this transcriptionId.",
    progress: { pct: 0, processedS: 0, segmentsDone: 0, totalS: 120 },
    shareUrl: "https://vocalstack.com/t/abc",
    source: { durationS: 120, format: "mp3", kind: "url", name: "episode.mp3" },
    spokenLanguage: "en",
    state: "queued",
    transcriptionId: TID,
  });
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test("transcribe_url defaults: speaker labels auto, no share link, no key; a replay says so", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx(), headers: { "idempotent-replayed": "true" } });
  const r = await call(client, "transcribe_url", { url: "https://example.com/a.mp3" });
  const [post] = only("POST", "/v1/transcriptions");
  assert.equal(post.headers["idempotency-key"], undefined);
  assert.deepEqual(post.body, { url: "https://example.com/a.mp3", shareLink: false, settings: { speakerLabels: "auto" } });
  assert.equal(r.structuredContent.replayed, true);
  assert.deepEqual(seen(), ["POST /v1/transcriptions"]);
});

test("transcribe_file uploads the decoded file as multipart with its options", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx({ job: job("queued", {}, { source: { kind: "upload", name: "meeting.m4a" } }) }) });
  const bytes = Buffer.from("ID3 fake audio bytes \u0000\u0001\u0002");
  const r = await call(client, "transcribe_file", {
    filename: "meeting.m4a",
    fileBase64: `data:audio/mp4;base64,${bytes.toString("base64").replace(/(.{8})/g, "$1\n")}`,
    mimeType: "audio/mp4",
    idempotencyKey: "m-1",
  });
  assert.equal(r.isError, undefined, r.content[0].text);
  const [post] = only("POST", "/v1/transcriptions");
  assert.match(post.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.equal(post.headers["idempotency-key"], "m-1");
  assert.deepEqual(JSON.parse(post.body.options), { settings: { speakerLabels: "auto" }, shareLink: false });
  assert.equal(post.body.file.name, "meeting.m4a");
  assert.equal(post.body.file.type, "audio/mp4");
  assert.deepEqual(post.body.file.bytes, bytes);
  assert.equal(r.structuredContent.kind, "file");
  assert.deepEqual(r.structuredContent.source, { kind: "upload", name: "meeting.m4a" });
});

test("transcribe_file refuses bad base64, an empty file and one over 10 MiB before any request", async () => {
  let r = await call(client, "transcribe_file", { filename: "a.mp3", fileBase64: "AA*A" });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.match(r.content[0].text, /^fileBase64 is not valid base64/);
  r = await call(client, "transcribe_file", { filename: "a.mp3", fileBase64: "data:audio/mpeg;base64," });
  assert.equal(r.content[0].text, "`fileBase64` is required");
  r = await call(client, "transcribe_file", { filename: "a.mp3", fileBase64: "====" });
  assert.equal(r.structuredContent.error, "invalid_options");
  r = await call(client, "transcribe_file", { filename: "a.mp3", fileBase64: "" });
  assert.equal(r.content[0].text, "`fileBase64` is required");
  const over = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
  r = await call(client, "transcribe_file", { filename: "a.mp3", fileBase64: over });
  assert.equal(r.content[0].text, "the file is over 10 MiB; give transcribe_url a link to it instead");
  const big = Buffer.alloc(10 * 1024 * 1024 + 1024).toString("base64");
  r = await call(client, "transcribe_file", { filename: "a.mp3", fileBase64: big });
  assert.equal(r.content[0].text, "fileBase64 is over 10 MiB decoded; give transcribe_url a link to the file instead");
  assert.equal(fake.requests.length, 0);
});

test("a 10 MiB file goes through stdio and up in one request", async () => {
  fake.on("POST", "/v1/transcriptions", { status: 201, body: tx() });
  const bytes = Buffer.alloc(10 * 1024 * 1024, 7);
  const r = await call(client, "transcribe_file", { filename: "big.wav", fileBase64: bytes.toString("base64") });
  assert.equal(r.isError, undefined, r.content[0]?.text);
  const [post] = only("POST", "/v1/transcriptions");
  assert.equal(post.body.file.bytes.length, bytes.length);
  assert.equal(post.body.file.type, "application/octet-stream");
});

test("get_transcription pages readable text with speakers and marks a running one partial", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing", { pct: 40, processedS: 48 }) }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  let r = await call(client, "get_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.text, "[00:00] Ana: Hello there.\n[00:03] Speaker 2: Hi Ana.\n[01:15] Ana: Bye.");
  assert.equal(r.structuredContent.segmentCount, 3);
  assert.equal(r.structuredContent.partial, true);
  assert.equal(r.structuredContent.nextOffset, undefined);
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
  r = await call(client, "translate_transcription", { transcriptionId: TID, lang: "es", format: "segments" });
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

test("wait_for_transcription polls the job each second until it is done, with progress", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("fetching", { pct: 0, fetchedBytes: 1_500_000, fetchTotalBytes: 3_000_000 }) }) });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("transcribing", { pct: 50, processedS: 60 }) });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("done", { pct: 100, processedS: 120 }, { finishedAt: "2026-11-19T10:05:00Z" }) });
  const updates = [];
  const t0 = Date.now();
  const r = await call(client, "wait_for_transcription", { transcriptionId: TID }, { onprogress: (p) => updates.push(p) });
  const took = Date.now() - t0;
  assert.ok(took >= 1800 && took < 5000, `took ${took} ms`);
  assert.equal(r.structuredContent.state, "done");
  assert.equal(r.structuredContent.timedOut, false);
  assert.equal(r.structuredContent.finishedAt, "2026-11-19T10:05:00Z");
  assert.equal(only("GET", `/v1/transcriptions/${TID}/job`).length, 2);
  assert.deepEqual(
    updates.map((u) => [u.progress, u.total, u.message]),
    [
      [0, 100, "fetching 1.5 / 3.0 MB"],
      [50, 100, "transcribing 01:00 of 02:00"],
    ],
  );
});

test("wait_for_transcription times out with timedOut true, and returns a live one at once", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("queued") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/job`, { body: job("queued") });
  let r = await call(client, "wait_for_transcription", { transcriptionId: TID, timeoutS: 1 });
  assert.equal(r.structuredContent.timedOut, true);
  assert.equal(r.structuredContent.state, "queued");
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("live") });
  r = await call(client, "wait_for_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.kind, "live");
  assert.equal(r.structuredContent.timedOut, false);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);
  r = await call(client, "wait_for_transcription", { transcriptionId: TID, timeoutS: 61 });
  assert.equal(r.content[0].text, "`timeoutS` must be an integer from 1 to 60");
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

test("search_transcriptions checks the transcription, then searches", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("GET", "/v1/search", {
    body: {
      query: "budget",
      queryEn: "budget",
      more: false,
      hits: [
        { transcriptionId: TID, linkName: "Episode 12", linkCode: "abc", mediaStart: 12.5, wallStart: 12.5, speaker: 1, text: "The budget.", score: 0.9, live: false, sentenceId: 4, rendered: "El presupuesto.", recordedAt: T0 },
      ],
    },
  });
  const r = await call(client, "search_transcriptions", { query: " budget ", transcriptionId: TID, lang: "es", limit: 5 });
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, "GET /v1/search"]);
  assert.deepEqual(only("GET", "/v1/search")[0].query, { q: "budget", transcription: TID, lang: "es", limit: "5" });
  assert.deepEqual(r.structuredContent, {
    hits: [{ live: false, mediaStart: 12.5, name: "Episode 12", recordedAt: T0, rendered: "El presupuesto.", score: 0.9, speaker: 1, text: "The budget.", transcriptionId: TID }],
    query: "budget",
    queryEn: "budget",
  });
});

test("search_by_meaning returns passages and what is left this hour", async () => {
  fake.on("GET", "/v1/search/vector", {
    body: {
      query: "hiring",
      state: "ready",
      allowance: { limit: 60, remaining: 59, resetsAt: null },
      hits: [
        { transcriptionId: TID, linkName: "Episode 12", linkCode: "abc", mediaStart: 30, wallStart: 30, speaker: 0, text: "We hire.", score: 1, live: true, sentenceId: 1, vector: true, similarity: 0.81234, passage: { text: "We hire two people.", mediaStart: 28, mediaEnd: 40 } },
      ],
    },
  });
  const r = await call(client, "search_by_meaning", { query: "What about hiring?" });
  assert.deepEqual(only("GET", "/v1/search/vector")[0].query, { q: "What about hiring?" });
  assert.deepEqual(r.structuredContent, {
    passages: [{ live: true, mediaEnd: 40, mediaStart: 28, name: "Episode 12", similarity: 0.812, text: "We hire two people.", transcriptionId: TID }],
    query: "hiring",
    searchesLeftThisHour: 59,
    state: "ready",
  });
});

test("get_summary reads a ready summary in a language", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "ready", title: "Titre", summary: "Résumé", lang: "fr" } });
  const r = await call(client, "get_summary", { transcriptionId: TID, lang: "FR" });
  assert.deepEqual(only("GET", `/v1/transcriptions/${TID}/summary`)[0].query, { lang: "fr" });
  assert.deepEqual(r.structuredContent, { lang: "fr", state: "ready", summary: "Résumé", title: "Titre" });
  assert.equal(only("POST", `/v1/transcriptions/${TID}/summarize`).length, 0);
});

test("get_summary asks for one when a finished transcription has none", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  fake.on("POST", `/v1/transcriptions/${TID}/summarize`, { body: { state: "pending" } });
  const r = await call(client, "get_summary", { transcriptionId: TID });
  assert.deepEqual(r.structuredContent, { message: "The summary is being written; ask again in a few seconds.", state: "pending" });
  assert.equal(only("POST", `/v1/transcriptions/${TID}/summarize`).length, 1);
});

test("get_summary: running, failed and short transcriptions", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  let r = await call(client, "get_summary", { transcriptionId: TID });
  assert.equal(r.structuredContent.state, "pending");
  assert.match(r.structuredContent.message, /still running/);
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("failed") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "unavailable" } });
  r = await call(client, "get_summary", { transcriptionId: TID });
  assert.deepEqual(r.structuredContent, { message: "The transcription failed, so there is nothing to summarise.", state: "unavailable" });
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/summary`, { body: { state: "not_requested" } });
  fake.on("POST", `/v1/transcriptions/${TID}/summarize`, { body: { state: "not_requested" } });
  r = await call(client, "get_summary", { transcriptionId: TID });
  assert.deepEqual(r.structuredContent, { message: "Transcriptions shorter than a minute are not summarised.", state: "not_requested" });
});

test("translate_transcription translates only the sentences on the page that lack it", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", `/v1/transcriptions/${TID}/translation`, { body: { lang: "es", translations: { 11: "Hola Ana." } } });
  fake.on("GET", `/v1/transcriptions/${TID}/translation`, { body: { lang: "es", translations: { 13: "Adiós." } } });
  const r = await call(client, "translate_transcription", { transcriptionId: TID, lang: "es", limit: 2 });
  assert.deepEqual(only("GET", `/v1/transcriptions/${TID}/translation`)[0].query, { lang: "es", sentences: "11" });
  assert.deepEqual(r.structuredContent, {
    lang: "es",
    nextOffset: 2,
    segmentCount: 3,
    text: "[00:00] Ana: Hola.\n[00:03] Speaker 2: Hola Ana.",
    translated: true,
  });
  const s = await call(client, "translate_transcription", { transcriptionId: TID, lang: "es", format: "segments", offset: 2 });
  assert.deepEqual(only("GET", `/v1/transcriptions/${TID}/translation`)[1].query, { lang: "es", sentences: "13" });
  assert.deepEqual(s.structuredContent.segments, [{ end: 80, language: "es", speaker: 0, speakerName: "Ana", speakerNumber: 1, start: 75.4, text: "Adiós." }]);
});

test("translate_transcription: the spoken language comes back untranslated", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  const r = await call(client, "translate_transcription", { transcriptionId: TID, lang: "en-GB" });
  assert.equal(r.structuredContent.translated, false);
  assert.equal(r.structuredContent.lang, "en-gb");
  assert.equal(r.structuredContent.segmentCount, 3);
  assert.equal(only("GET", `/v1/transcriptions/${TID}/translation`).length, 0);
});

test("translate_transcription refuses an open live transcription and an unfinished file", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: liveTx("live") });
  let r = await call(client, "translate_transcription", { transcriptionId: TID, lang: "es" });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(
    r.content[0].text,
    "the live transcription is still running; read the text so far with get_transcription, or stop it (stop_broadcast) and translate it then",
  );
  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("transcribing") }) });
  r = await call(client, "translate_transcription", { transcriptionId: TID, lang: "es" });
  assert.equal(r.content[0].text, "the transcription is transcribing; wait until it is done (wait_for_transcription)");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);
});

test("translate_transcription: a language the API does not translate into", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ job: job("done") }) });
  fake.on("GET", `/v1/transcriptions/${TID}/transcript`, { body: snapshot() });
  fake.on("GET", `/v1/transcriptions/${TID}/translation`, apiError(400, "invalid_options", "lang is a translation target"));
  const r = await call(client, "translate_transcription", { transcriptionId: TID, lang: "xx" });
  assert.equal(r.content[0].text, '`lang` "xx" is not a language this API translates into');
});

test("list_voices maps the catalogue and makes preview links absolute", async () => {
  fake.on("GET", "/v1/voices/available", {
    body: {
      lang: "en",
      voices: [
        { id: "v1", name: "Ava", default: true, cloned: false, quality: 3, gender: "female", accent: "us", previewUrl: "/v1/voices/v1/preview", speakers: 0 },
        { id: "clone:x", name: "Ana", default: false, cloned: true, quality: 2, previewUrl: null, speakers: 0 },
      ],
    },
  });
  const r = await call(client, "list_voices", { lang: "en" });
  assert.deepEqual(only("GET", "/v1/voices/available")[0].query, { lang: "en" });
  assert.deepEqual(r.structuredContent.voices, [
    { accent: "us", cloned: false, default: true, gender: "female", id: "v1", name: "Ava", previewUrl: `${fake.url}/v1/voices/v1/preview`, quality: 3 },
    { cloned: true, default: false, id: "clone:x", name: "Ana", quality: 2 },
  ]);
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

test("list_broadcasts and get_broadcast", async () => {
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
  assert.deepEqual(l.structuredContent.broadcasts, [
    { access: "public", broadcastId: BID, lastRecordedAt: T0, link: "https://vocalstack.com/sunday", listenersNow: 3, name: "Sunday service", onAir: true, onAirSince: T0, state: "live", transcriptionId: TID },
    { access: "public", archived: true, broadcastId: "b2", link: "https://vocalstack.com/sunday", listenersNow: 0, name: "Sunday service", onAir: false },
  ]);
  const g = await call(client, "get_broadcast", { broadcastId: BID });
  assert.equal(g.structuredContent.transcriptions.length, 20);
  assert.deepEqual(g.structuredContent.transcriptions[0], { lastRecordedAt: T0, name: "Take 0", recording: true, transcriptionId: "t0" });
  assert.deepEqual(g.structuredContent.transcriptions[1], { name: "Take 1", recording: false, transcriptionId: "t1" });
  assert.deepEqual(g.structuredContent.streams, [{ name: "Radio", url: "https://radio.example/live.m3u8" }]);
  fake.reset();
  fake.on("GET", `/v1/broadcasts/${BID}`, apiError(404, "not_found", "nope"));
  const n = await call(client, "get_broadcast", { broadcastId: BID });
  assert.equal(n.content[0].text, "No broadcast with that id for this account.");
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

test("API errors become tool errors with code, plain message, retryable, retryAfterS and topUpUrl", async () => {
  fake.on("POST", "/v1/transcriptions", apiError(402, "insufficient_credit", "Not enough credit.", { balance: 0, required: 5 }));
  let r = await call(client, "transcribe_url", { url: "https://example.com/a.mp3" });
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
