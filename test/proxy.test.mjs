import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const GOOD_KEY = "vs_test_good";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    outputSchema: { type: "object", properties: { text: { type: "string" }, bytes: { type: "number" } } },
  },
  { name: "fails", description: "Always fails.", inputSchema: { type: "object" } },
  { name: "slow", description: "Reports progress.", inputSchema: { type: "object" } },
];

const seen = [];

function fakeServer() {
  const server = new Server(
    { name: "fake-vocalstack", version: "9.9.9" },
    { capabilities: { tools: { listChanged: false } }, instructions: "Fake instructions." },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    if (name === "echo") {
      return {
        content: [{ type: "text", text: args.text.slice(0, 20) }],
        structuredContent: { text: args.text.slice(0, 20), bytes: args.text.length },
      };
    }
    if (name === "fails") {
      return { content: [{ type: "text", text: "Recording not found." }], isError: true };
    }
    if (name === "slow") {
      const token = request.params._meta?.progressToken;
      for (let i = 1; i <= 3; i++) {
        if (token !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: i, total: 3, message: `step ${i}` },
          });
        }
      }
      return { content: [{ type: "text", text: "done" }] };
    }
    throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  });
  return server;
}

let http;
let url;

before(async () => {
  http = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const auth = req.headers.authorization;
    seen.push({ method: body.method, auth, userAgent: req.headers["user-agent"] });
    const messages = Array.isArray(body) ? body : [body];
    const needsKey = messages.some((m) => m.method === "tools/call");
    if (auth !== undefined && auth !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="test"' }).end("invalid token");
      return;
    }
    if (needsKey && !auth) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="test"' }).end("sign in");
      return;
    }
    const server = fakeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${http.address().port}/v1/mcp`;
});

after(() => new Promise((resolve) => http.close(resolve)));

async function connect(apiKey) {
  const env = { ...process.env, VOCALSTACK_MCP_URL: url };
  delete env.VOCALSTACK_API_KEY;
  if (apiKey !== undefined) env.VOCALSTACK_API_KEY = apiKey;
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("initialize mirrors the remote server", async () => {
  const client = await connect(GOOD_KEY);
  try {
    assert.deepEqual(client.getServerVersion(), { name: "fake-vocalstack", version: "9.9.9" });
    assert.equal(client.getInstructions(), "Fake instructions.");
    assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: false });
  } finally {
    await client.close();
  }
});

test("tools/list passes through", async () => {
  const client = await connect(GOOD_KEY);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools, TOOLS);
  } finally {
    await client.close();
  }
});

test("tools/call passes through, with the key and user agent sent", async () => {
  seen.length = 0;
  const client = await connect(GOOD_KEY);
  try {
    const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
    assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
    assert.deepEqual(result.structuredContent, { text: "hello", bytes: 5 });
    const failed = await client.callTool({ name: "fails", arguments: {} });
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [{ type: "text", text: "Recording not found." }]);
  } finally {
    await client.close();
  }
  const call = seen.find((s) => s.method === "tools/call");
  assert.equal(call.auth, `Bearer ${GOOD_KEY}`);
  assert.match(call.userAgent, /^vocalstack-mcp\/\d+\.\d+\.\d+$/);
});

test("protocol errors pass through unchanged", async () => {
  const client = await connect(GOOD_KEY);
  try {
    await assert.rejects(client.callTool({ name: "nope", arguments: {} }), (error) => {
      assert.equal(error.code, -32602);
      assert.equal(error.message, "MCP error -32602: Unknown tool: nope");
      return true;
    });
  } finally {
    await client.close();
  }
});

test("progress notifications reach the caller", async () => {
  const client = await connect(GOOD_KEY);
  try {
    const updates = [];
    const result = await client.callTool({ name: "slow", arguments: {} }, CallToolResultSchema, {
      onprogress: (p) => updates.push(p),
    });
    assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
    assert.deepEqual(
      updates.map((u) => [u.progress, u.total, u.message]),
      [
        [1, 3, "step 1"],
        [2, 3, "step 2"],
        [3, 3, "step 3"],
      ],
    );
  } finally {
    await client.close();
  }
});

test("without a key, listing works and a call says to set the key", async () => {
  seen.length = 0;
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOLS.length);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [
      {
        type: "text",
        text: "Set VOCALSTACK_API_KEY to an API key from https://app.vocalstack.com (Developers → API keys).",
      },
    ]);
  } finally {
    await client.close();
  }
  assert.ok(seen.every((s) => s.auth === undefined));
});

test("a refused key is named as refused", async () => {
  const client = await connect("vs_test_wrong");
  try {
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^The API key was refused/);
    await assert.rejects(client.listTools(), /The API key was refused/);
  } finally {
    await client.close();
  }
});

test("a 14 MB argument goes through", async () => {
  const client = await connect(GOOD_KEY);
  try {
    const text = "A".repeat(14 * 1024 * 1024);
    const result = await client.callTool({ name: "echo", arguments: { text } });
    assert.equal(result.structuredContent.bytes, text.length);
  } finally {
    await client.close();
  }
});
