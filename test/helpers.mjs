import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
export const KEY = "vs_key_test";
export const DEFS = JSON.parse(readFileSync(new URL("../src/tools.json", import.meta.url), "utf8"));
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export class FakeApi {
  constructor() {
    this.requests = [];
    this.routes = new Map();
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  reset() {
    this.requests = [];
    this.routes = new Map();
  }

  on(method, path, reply) {
    const list = this.routes.get(`${method} ${path}`) ?? [];
    list.push(reply);
    this.routes.set(`${method} ${path}`, list);
  }

  async handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, this.url);
    const ctype = req.headers["content-type"] ?? "";
    let body;
    if (ctype.startsWith("application/json")) body = JSON.parse(raw.toString("utf8"));
    else if (ctype.startsWith("multipart/form-data")) {
      const form = await new Request(u, { method: "POST", headers: { "content-type": ctype }, body: raw }).formData();
      body = {};
      for (const [k, v] of form.entries()) {
        body[k] = typeof v === "string" ? v : { name: v.name, type: v.type, bytes: Buffer.from(await v.arrayBuffer()) };
      }
    }
    const entry = {
      method: req.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: req.headers,
      body,
    };
    this.requests.push(entry);
    const list = this.routes.get(`${req.method} ${u.pathname}`);
    if (!list || list.length === 0) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "not_found", status: 404, message: `no fake route ${req.method} ${u.pathname}`, data: { retryable: false } }));
      return;
    }
    const reply = list.length > 1 ? list.shift() : list[0];
    const out = typeof reply === "function" ? await reply(entry) : reply;
    const status = out.status ?? 200;
    res.writeHead(status, { "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body ?? {}));
  }
}

export function apiError(status, code, message, details, retryable = false) {
  return { status, body: { defined: true, code, status, message, data: { retryable, ...(details ? { details } : {}) } } };
}

export async function connect(fake, apiKey = KEY, env = {}) {
  const e = { ...process.env, VOCALSTACK_API_URL: fake?.url ?? "http://127.0.0.1:9", ...env };
  delete e.VOCALSTACK_API_KEY;
  if (apiKey !== null) e.VOCALSTACK_API_KEY = apiKey;
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: e, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export async function call(client, name, args, options) {
  return client.callTool({ name, arguments: args }, undefined, options);
}
