import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = new URL("../", import.meta.url);
const NEXT = new URL("./next-tools.json", import.meta.url);

export const KEY = "vs_key_test";
export const SYNCED = JSON.parse(readFileSync(new URL("src/tools.json", ROOT), "utf8"));
export const AWAITING_SYNC = existsSync(NEXT);
export const DEFS = AWAITING_SYNC ? JSON.parse(readFileSync(NEXT, "utf8")) : SYNCED;

function awaitingSyncBin() {
  const dist = new URL("dist/", ROOT);
  const h = createHash("sha256");
  for (const f of readdirSync(dist).sort()) {
    if (f !== "tools.json") h.update(f).update(readFileSync(new URL(f, dist)));
  }
  h.update(readFileSync(NEXT)).update(readFileSync(new URL("package.json", ROOT)));
  const id = h.digest("hex").slice(0, 16);
  const home = new URL(".awaiting-sync/", ROOT);
  const dir = new URL(`${id}/`, home);
  const bin = fileURLToPath(new URL("dist/index.js", dir));
  if (existsSync(bin)) return bin;
  const tmp = new URL(`${id}.${process.pid}/`, home);
  mkdirSync(tmp, { recursive: true });
  cpSync(dist, new URL("dist/", tmp), { recursive: true });
  writeFileSync(new URL("dist/tools.json", tmp), readFileSync(NEXT));
  writeFileSync(new URL("package.json", tmp), readFileSync(new URL("package.json", ROOT)));
  try {
    renameSync(tmp, dir);
  } catch {
    rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

export const BIN = AWAITING_SYNC ? awaitingSyncBin() : fileURLToPath(new URL("dist/index.js", ROOT));
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export class FakeApi {
  constructor() {
    this.requests = [];
    this.routes = new Map();
    this.fixed = new Map();
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

  always(method, path, reply) {
    this.fixed.set(`${method} ${path}`, reply);
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
    const list = this.routes.get(`${req.method} ${u.pathname}`) ?? (this.fixed.has(`${req.method} ${u.pathname}`) ? [this.fixed.get(`${req.method} ${u.pathname}`)] : undefined);
    if (!list || list.length === 0) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "not_found", status: 404, message: `no fake route ${req.method} ${u.pathname}`, data: { retryable: false } }));
      return;
    }
    const reply = list.length > 1 ? list.shift() : list[0];
    const out = typeof reply === "function" ? await reply(entry) : reply;
    const status = out.status ?? 200;
    if (status === 204) {
      res.writeHead(204, out.headers ?? {});
      res.end();
      return;
    }
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
