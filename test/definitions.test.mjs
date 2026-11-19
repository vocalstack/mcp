import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handlers } from "../dist/handlers.js";
import { PENDING, RETIRED, check } from "../scripts/check-handlers.mjs";
import { toolLines, withTools } from "../scripts/readme-tools.mjs";
import { AWAITING_SYNC, DEFS, SYNCED } from "./helpers.mjs";

const names = (d) => d.tools.map((t) => t.name);

test("every tool served has a handler, and every handler a tool", () => {
  assert.deepEqual(Object.keys(handlers).sort(), [...names(DEFS)].sort());
});

test("src/tools.json passes the handler check (PENDING and RETIRED cover the hosted release still to come)", () => {
  assert.deepEqual(check(names(SYNCED)), []);
  assert.deepEqual(Object.keys(handlers).filter((n) => !PENDING.includes(n)).sort(), names(SYNCED).filter((n) => !RETIRED.includes(n)).sort());
});

test("the scaffolding for the hosted release is temporary", () => {
  if (!AWAITING_SYNC) {
    assert.deepEqual(PENDING, [], "src/tools.json is synced: empty PENDING in scripts/check-handlers.mjs");
    assert.deepEqual(RETIRED, [], "src/tools.json is synced: empty RETIRED in scripts/check-handlers.mjs");
    return;
  }
  const synced = new Map(SYNCED.tools.map((t) => [t.name, t]));
  const landed = DEFS.tools.every((t) => synced.has(t.name)) && SYNCED.tools.length === DEFS.tools.length;
  if (landed) {
    for (const t of DEFS.tools) assert.deepEqual(synced.get(t.name).inputSchema, t.inputSchema, `${t.name}: the hosted schema differs from test/next-tools.json`);
  }
  assert.ok(!landed, "src/tools.json now lists the hosted tools: delete test/next-tools.json and empty PENDING and RETIRED in scripts/check-handlers.mjs");
  assert.deepEqual([...PENDING].sort(), names(DEFS).filter((n) => !synced.has(n)).sort());
  assert.deepEqual([...RETIRED].sort(), names(SYNCED).filter((n) => !names(DEFS).includes(n)).sort());
});

test("the handler check is a waiting room in both directions", () => {
  assert.deepEqual(check(["a"], ["a", "p"], ["p"], []), []);
  assert.deepEqual(check(["a", "r"], ["a"], [], ["r"]), []);
  assert.deepEqual(check(["a", "b"], ["a", "b", "c"], ["p"], []), ["Handlers with no tool: c", "In PENDING with no handler: p"]);
  assert.deepEqual(check(["a", "p"], ["a", "p"], ["p"], []), ["Now in tools.json, remove from PENDING in scripts/check-handlers.mjs: p"]);
  assert.deepEqual(check(["a", "b"], ["a"], [], []), ["Tools with no handler: b"]);
  assert.deepEqual(check(["a"], ["a"], [], ["r"]), ["No longer in tools.json, remove from RETIRED in scripts/check-handlers.mjs: r"]);
  assert.deepEqual(check(["a", "r"], ["a", "r"], [], ["r"]), ["In RETIRED but still handled: r"]);
});

test("the tool definitions hold the hosted instructions and complete definitions", () => {
  for (const d of [DEFS, SYNCED]) {
    assert.ok(d.instructions.length > 100);
    for (const t of d.tools) {
      assert.ok(t.description, t.name);
      assert.ok(t.title, t.name);
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      assert.ok(t.annotations, t.name);
    }
  }
  assert.equal(DEFS.tools.length, 15);
  for (const n of names(DEFS)) assert.ok(DEFS.instructions.includes(n), `the instructions name ${n}`);
});

test("the README's tool list is the first sentence of each description in src/tools.json", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(withTools(readme, SYNCED.tools) === readme, "the README's tool list is stale: run npm run sync-tools");
  const lines = toolLines(DEFS.tools);
  assert.equal(lines.length, 15);
  assert.equal(lines[0], "- `create_transcription`: Start transcribing a finished recording, from a public link or a file sent inline; returns a transcriptionId at once, before any text.");
  for (const l of lines) assert.match(l, /^- `[a-z_]+`: [^\n]+[.!?]$/);
});
