#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

const MAX_STDIN_MESSAGE_BYTES = 64 * 1024 * 1024;

function log(message: string): void {
  process.stderr.write(`[vocalstack-mcp] ${message}\n`);
}

async function main(): Promise<void> {
  const apiKey = process.env.VOCALSTACK_API_KEY?.trim() || undefined;
  const baseUrl = process.env.VOCALSTACK_API_URL?.trim() || undefined;
  if (!apiKey) log("VOCALSTACK_API_KEY is not set: the tools are listed, and each call asks for a key.");
  const server = createServer({ apiKey, baseUrl });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.close().catch(() => {});
    process.exit(0);
  };

  let pending = 0;
  let ending = false;
  const settle = () => {
    if (ending && pending === 0) setImmediate(() => void shutdown());
  };

  const stdio = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_STDIN_MESSAGE_BYTES });
  stdio.onclose = () => void shutdown();
  await server.connect(stdio);

  const receive = stdio.onmessage;
  stdio.onmessage = (message: JSONRPCMessage) => {
    if ("method" in message && "id" in message) pending++;
    receive?.(message);
  };
  const send = stdio.send.bind(stdio);
  stdio.send = async (message: JSONRPCMessage) => {
    await send(message);
    if ("id" in message && ("result" in message || "error" in message)) {
      pending = Math.max(0, pending - 1);
      settle();
    }
  };

  process.stdin.on("end", () => {
    ending = true;
    settle();
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
