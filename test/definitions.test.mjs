import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../dist/handlers.js";
import { DEFS } from "./helpers.mjs";

test("every tool in tools.json has a handler, and every handler a tool", () => {
  assert.deepEqual(Object.keys(handlers).sort(), DEFS.tools.map((t) => t.name).sort());
});

test("tools.json holds the hosted instructions and complete definitions", () => {
  assert.ok(DEFS.instructions.length > 100);
  for (const t of DEFS.tools) {
    assert.ok(t.description, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.annotations, t.name);
  }
});
