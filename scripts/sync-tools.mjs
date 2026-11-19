#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withTools } from "./readme-tools.mjs";

const DEFAULT_OUT = fileURLToPath(new URL("../src/tools.json", import.meta.url));
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const PROTOCOL = "2025-06-18";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const url = arg("--url") || process.env.VOCALSTACK_MCP_URL || "https://api.vocalstack.com/v1/mcp";
const out = arg("--out") || DEFAULT_OUT;
const check = process.argv.includes("--check");

async function rpc(id, method, params, session) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
    "user-agent": "vocalstack-mcp-sync",
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  let message;
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const m = JSON.parse(data);
      if (m.id === id) message = m;
    }
  } else {
    message = JSON.parse(text);
  }
  if (!message) throw new Error(`${method}: no response`);
  if (message.error) throw new Error(`${method}: ${message.error.message}`);
  return { result: message.result, session: res.headers.get("mcp-session-id") || session };
}

const init = await rpc(1, "initialize", {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: "vocalstack-mcp-sync", version: "1" },
});
const tools = [];
let cursor;
let id = 2;
do {
  const { result } = await rpc(id++, "tools/list", cursor ? { cursor } : {}, init.session);
  tools.push(...result.tools);
  cursor = result.nextCursor;
} while (cursor);

const doc = { instructions: init.result.instructions ?? "", tools };
const text = JSON.stringify(doc, null, 2) + "\n";

if (check) {
  const current = readFileSync(DEFAULT_OUT, "utf8");
  if (current !== text) {
    console.error("src/tools.json differs from the hosted server's tools; run npm run sync-tools and commit the result.");
    process.exit(1);
  }
  console.log(`src/tools.json matches the hosted server (${tools.length} tools).`);
} else {
  writeFileSync(out, text);
  console.log(`Wrote ${tools.length} tools to ${out}.`);
  if (out === DEFAULT_OUT) {
    const readme = readFileSync(README, "utf8");
    const next = withTools(readme, tools);
    if (next !== readme) writeFileSync(README, next);
  }
}
