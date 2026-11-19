#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const defs = JSON.parse(readFileSync(new URL("../src/tools.json", import.meta.url), "utf8"));
const env = { ...process.env };
delete env.VOCALSTACK_API_KEY;
delete env.VOCALSTACK_API_URL;

const client = new Client({ name: "vocalstack-mcp-smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env, stderr: "ignore" }));
const { tools } = await client.listTools();
const instructions = client.getInstructions();
await client.close();

const local = tools.map((t) => t.name);
const failures = [];
if (!isDeepStrictEqual(tools, defs.tools)) failures.push("the local server's tools/list differs from src/tools.json");
if (instructions !== defs.instructions) failures.push("the local server's instructions differ from src/tools.json");

execFileSync(process.execPath, [fileURLToPath(new URL("./sync-tools.mjs", import.meta.url)), "--check"], { stdio: "inherit" });

if (failures.length) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`The local server lists the same ${local.length} tools as tools.json and the hosted server: ${local.join(", ")}.`);
