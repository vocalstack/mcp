import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Api } from "../dist/api.js";
import { Args } from "../dist/args.js";
import { ToolError } from "../dist/errors.js";
import { handlers } from "../dist/handlers.js";
import { toolError, toolOk } from "../dist/result.js";
import { FakeApi, apiError, connect, call, KEY, DEFS, VERSION } from "./helpers.mjs";

const SCHEMAS = JSON.parse(readFileSync(new URL("./pending-tools.json", import.meta.url), "utf8"));
const TID = "0190f0e0-7c1a-7d3e-9b2a-5f4e3d2c1b0a";
const T0 = "2026-11-19T10:00:00Z";

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

const listed = (name) => DEFS.tools.find((t) => t.name === name);

async function run(name, args) {
  if (listed(name)) return call(client, name, args);
  const api = new Api(fake.url, KEY, `vocalstack-mcp/${VERSION}`);
  const ctx = { api, signal: new AbortController().signal };
  try {
    return toolOk(await handlers[name](Args.parse(SCHEMAS[name], args), ctx));
  } catch (e) {
    if (e instanceof ToolError) return toolError(e);
    throw e;
  }
}

const seen = () => fake.requests.map((r) => `${r.method} ${r.path}`);

const tx = (extra = {}) => ({
  id: TID,
  name: "Episode 12",
  createdAt: T0,
  state: "idle",
  lifecycle: "active",
  spokenLanguage: "en",
  settings: { speakerLabels: "auto", voiceCloning: false },
  broadcasts: [],
  job: null,
  ...extra,
});

test("the argument schemas used here are the hosted ones once tools.json lists them", () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const t = listed(name);
    if (!t) continue;
    assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), Object.keys(schema.properties).sort(), name);
    assert.deepEqual([...(t.inputSchema.required ?? [])].sort(), [...schema.required].sort(), name);
  }
});

test("delete_transcription checks the transcription, archives it and returns when it can be restored", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("POST", `/v1/transcriptions/${TID}/archive`, {
    body: tx({ lifecycle: "archived", archivedAt: "2026-11-19T11:00:00Z", purgeAfter: "2026-12-19T11:00:00Z" }),
  });
  const r = await run("delete_transcription", { transcriptionId: TID.toUpperCase() });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `POST /v1/transcriptions/${TID}/archive`]);
  const post = fake.requests[1];
  assert.equal(post.headers.authorization, `Bearer ${KEY}`);
  assert.equal(post.body, undefined);
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
  let r = await run("delete_transcription", { transcriptionId: TID });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.structuredContent.status, 409);
  assert.equal(r.content[0].text, "This transcription is still recording live; stop it first (stop_broadcast for a broadcast), then delete it.");

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("POST", `/v1/transcriptions/${TID}/archive`, apiError(409, "invalid_state", "this transcription is locked; unlock it before archiving it"));
  r = await run("delete_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.content[0].text, "this transcription is locked; unlock it before archiving it");

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(404, "not_found", "transcription not found"));
  r = await run("delete_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("POST", `/v1/transcriptions/${TID}/archive`, apiError(403, "forbidden", "this key lacks the write scope", { requiredScope: ["write"] }));
  r = await run("delete_transcription", { transcriptionId: TID });
  assert.equal(r.structuredContent.error, "forbidden");
  assert.deepEqual(r.structuredContent.details, { requiredScope: ["write"] });
});

test("rename_speaker puts the trimmed name on the speaker's number", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/2`, { body: { ok: true } });
  const r = await run("rename_speaker", { transcriptionId: TID, speaker: 2, name: "  Maria Lopez " });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `PUT /v1/transcriptions/${TID}/appearances/2`]);
  const put = fake.requests[1];
  assert.equal(put.headers.authorization, `Bearer ${KEY}`);
  assert.match(put.headers["content-type"], /^application\/json/);
  assert.deepEqual(put.body, { name: "Maria Lopez" });
  assert.deepEqual(r.structuredContent, { name: "Maria Lopez", speaker: 2, transcriptionId: TID });
});

test("rename_speaker: an empty name clears it; a long one is cut to 80 characters", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/1`, { body: { ok: true } });
  let r = await run("rename_speaker", { transcriptionId: TID, speaker: 1, name: "   " });
  assert.deepEqual(fake.requests[1].body, { name: null });
  assert.deepEqual(r.structuredContent, { name: null, speaker: 1, transcriptionId: TID });
  fake.requests = [];
  r = await run("rename_speaker", { transcriptionId: TID, speaker: 1, name: "é".repeat(90) });
  assert.deepEqual(fake.requests[1].body, { name: "é".repeat(80) });
  assert.equal(r.structuredContent.name, "é".repeat(80));
});

test("rename_speaker: a number the transcription lacks, an unknown transcription, bad arguments", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/7`, apiError(404, "not_found", "this transcription has no speaker 7"));
  let r = await run("rename_speaker", { transcriptionId: TID, speaker: 7, name: "Ana" });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "This transcription has no Speaker 7; get_transcription shows the speaker numbers.");

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(403, "forbidden", "not yours"));
  r = await run("rename_speaker", { transcriptionId: TID, speaker: 1, name: "Ana" });
  assert.equal(r.structuredContent.error, "not_found");
  assert.equal(r.content[0].text, "No transcription with that id for this account.");

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PUT", `/v1/transcriptions/${TID}/appearances/1`, apiError(403, "forbidden", "this key lacks the write scope"));
  r = await run("rename_speaker", { transcriptionId: TID, speaker: 1, name: "Ana" });
  assert.equal(r.structuredContent.error, "forbidden");

  fake.reset();
  r = await run("rename_speaker", { transcriptionId: TID, speaker: 0, name: "Ana" });
  assert.equal(r.content[0].text, "`speaker` must be an integer from 1 to 1000");
  r = await run("rename_speaker", { transcriptionId: TID, speaker: 1.5, name: "Ana" });
  assert.equal(r.content[0].text, "`speaker` must be an integer from 1 to 1000");
  r = await run("rename_speaker", { transcriptionId: TID, speaker: 1, name: 3 });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, '`name` must be a string ("" clears the name)');
  r = await run("rename_speaker", { transcriptionId: TID, speaker: 1 });
  assert.equal(r.content[0].text, "`name` is required");
  assert.equal(fake.requests.length, 0);
});

test("set_cloned_voices patches voiceCloning with the consent beside it", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PATCH", `/v1/transcriptions/${TID}`, { body: tx({ settings: { speakerLabels: "auto", voiceCloning: true } }) });
  let r = await run("set_cloned_voices", { transcriptionId: TID, on: true, consent: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`, `PATCH /v1/transcriptions/${TID}`]);
  const patch = fake.requests[1];
  assert.equal(patch.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(patch.body, { settings: { voiceCloning: true, voiceCloningConsent: true } });
  assert.deepEqual(r.structuredContent, { clonedVoices: true, name: "Episode 12", transcriptionId: TID });

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on("PATCH", `/v1/transcriptions/${TID}`, { body: tx() });
  r = await run("set_cloned_voices", { transcriptionId: TID, on: false });
  assert.deepEqual(fake.requests[1].body, { settings: { voiceCloning: false, voiceCloningConsent: false } });
  assert.deepEqual(r.structuredContent, { clonedVoices: false, name: "Episode 12", transcriptionId: TID });
});

test("set_cloned_voices: no consent, a deleted transcription, an unknown one, bad arguments", async () => {
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx() });
  fake.on(
    "PATCH",
    `/v1/transcriptions/${TID}`,
    apiError(400, "invalid_options", "turning voiceCloning on needs voiceCloningConsent: true — confirm you have permission from everyone speaking"),
  );
  let r = await run("set_cloned_voices", { transcriptionId: TID, on: true });
  assert.deepEqual(fake.requests[1].body, { settings: { voiceCloning: true, voiceCloningConsent: false } });
  assert.equal(r.structuredContent.error, "invalid_options");
  assert.equal(r.content[0].text, "Turning cloned voices on needs consent: true, confirming everyone speaking agreed to have their voice cloned.");

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, { body: tx({ lifecycle: "archived" }) });
  fake.on("PATCH", `/v1/transcriptions/${TID}`, apiError(409, "invalid_state", "this transcription is archived; restore it first"));
  r = await run("set_cloned_voices", { transcriptionId: TID, on: true, consent: true });
  assert.equal(r.structuredContent.error, "invalid_state");
  assert.equal(r.content[0].text, "this transcription is archived; restore it first");

  fake.reset();
  fake.on("GET", `/v1/transcriptions/${TID}`, apiError(404, "not_found", "transcription not found"));
  r = await run("set_cloned_voices", { transcriptionId: TID, on: false });
  assert.equal(r.content[0].text, "No transcription with that id for this account.");
  assert.deepEqual(seen(), [`GET /v1/transcriptions/${TID}`]);

  fake.reset();
  r = await run("set_cloned_voices", { transcriptionId: TID, on: "yes" });
  assert.equal(r.content[0].text, "`on` must be true or false");
  r = await run("set_cloned_voices", { transcriptionId: TID, on: true, consent: "yes" });
  assert.equal(r.content[0].text, "`consent` must be true or false");
  r = await run("set_cloned_voices", { transcriptionId: TID });
  assert.equal(r.content[0].text, "`on` is required");
  r = await run("set_cloned_voices", { transcriptionId: TID, on: true, voice: "x" });
  assert.equal(r.content[0].text, "unknown argument `voice`; this tool takes consent, on, transcriptionId");
  assert.equal(fake.requests.length, 0);
});
