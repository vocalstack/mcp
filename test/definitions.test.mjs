import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../dist/handlers.js";
import { PENDING, check } from "../scripts/check-handlers.mjs";
import { DEFS } from "./helpers.mjs";

test("every tool in tools.json has a handler, and every handler a tool (or is pending the hosted release)", () => {
  const tools = DEFS.tools.map((t) => t.name);
  assert.deepEqual(check(tools), []);
  assert.deepEqual(Object.keys(handlers).filter((n) => !PENDING.includes(n)).sort(), [...tools].sort());
});

test("the pending list is only a waiting room", () => {
  assert.deepEqual(check(["a"], ["a", "p"], ["p"]), []);
  assert.deepEqual(check(["a", "b"], ["a", "b", "c"], ["p"]), ["Handlers with no tool: c", "In PENDING with no handler: p"]);
  assert.deepEqual(check(["a", "p"], ["a", "p"], ["p"]), ["Now in tools.json, remove from PENDING in scripts/check-handlers.mjs: p"]);
  assert.deepEqual(check(["a", "b"], ["a"], []), ["Tools with no handler: b"]);
});

test("tools.json holds the hosted instructions and complete definitions", () => {
  assert.ok(DEFS.instructions.length > 100);
  for (const t of DEFS.tools) {
    assert.ok(t.description, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.annotations, t.name);
  }
});
