#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  type Implementation,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_URL = "https://api.vocalstack.com/v1/mcp";
const KEY_MISSING =
  "Set VOCALSTACK_API_KEY to an API key from https://app.vocalstack.com (Developers → API keys).";
const KEY_REFUSED =
  "The API key was refused. Check that VOCALSTACK_API_KEY holds a current API key from https://app.vocalstack.com (Developers → API keys).";
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_STDIN_MESSAGE_BYTES = 64 * 1024 * 1024;

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function log(message: string): void {
  process.stderr.write(`[vocalstack-mcp] ${message}\n`);
}

class ForwardedError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

function unprefixed(message: string): string {
  return message.replace(/^MCP error -?\d+: /, "");
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError && error.code === 401)
  );
}

function isSessionGone(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

class Remote {
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(
    private readonly url: URL,
    private readonly apiKey: string | undefined,
  ) {}

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = this.open().then(
        (client) => {
          this.client = client;
          this.connecting = undefined;
          return client;
        },
        (error) => {
          this.connecting = undefined;
          throw error;
        },
      );
    }
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const headers: Record<string, string> = { "User-Agent": `vocalstack-mcp/${VERSION}` };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const transport = new StreamableHTTPClientTransport(this.url, { requestInit: { headers } });
    const client = new Client({ name: "vocalstack-mcp", version: VERSION }, { capabilities: {} });
    client.onerror = (error) => {
      if (!isUnauthorized(error)) log(`remote: ${error.message}`);
    };
    client.onclose = () => {
      if (this.client === client) this.client = undefined;
    };
    await client.connect(transport);
    return client;
  }

  async reset(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close().catch(() => {});
  }

  async call<T>(run: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await run(await this.connect());
    } catch (error) {
      if (!isSessionGone(error)) throw error;
      await this.reset();
      return run(await this.connect());
    }
  }
}

function forward(error: unknown): never {
  if (error instanceof McpError) {
    throw new ForwardedError(error.code, unprefixed(error.message), error.data);
  }
  throw error;
}

async function main(): Promise<void> {
  const url = new URL(process.env.VOCALSTACK_MCP_URL || DEFAULT_URL);
  const apiKey = process.env.VOCALSTACK_API_KEY?.trim() || undefined;
  const remote = new Remote(url, apiKey);

  let info: Implementation = { name: "vocalstack", version: VERSION };
  let instructions: string | undefined;
  try {
    const client = await remote.connect();
    info = client.getServerVersion() ?? info;
    instructions = client.getInstructions();
  } catch (error) {
    if (isUnauthorized(error)) log(apiKey ? KEY_REFUSED : KEY_MISSING);
    else log(`could not reach ${url.href} yet: ${error instanceof Error ? error.message : String(error)}`);
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await remote.reset();
    process.exit(0);
  };

  let pending = 0;
  let ending = false;
  const tracked = async <T>(run: () => Promise<T>): Promise<T> => {
    pending++;
    try {
      return await run();
    } finally {
      pending--;
      if (ending && pending === 0) setImmediate(() => void shutdown());
    }
  };

  const authMessage = () => (remote.hasKey ? KEY_REFUSED : KEY_MISSING);

  const server = new Server(info, {
    capabilities: { tools: { listChanged: false } },
    ...(instructions ? { instructions } : {}),
  });

  server.setRequestHandler(ListToolsRequestSchema, (request, extra) => tracked(async () => {
    try {
      return await remote.call((client) =>
        client.request({ method: "tools/list", params: request.params }, ListToolsResultSchema, {
          signal: extra.signal,
          timeout: REQUEST_TIMEOUT_MS,
        }),
      );
    } catch (error) {
      if (isUnauthorized(error)) throw new ForwardedError(ErrorCode.InvalidRequest, authMessage());
      forward(error);
    }
  }));

  server.setRequestHandler(CallToolRequestSchema, (request, extra) => tracked(async () => {
    const progressToken = request.params._meta?.progressToken;
    try {
      return await remote.call((client) =>
        client.request({ method: "tools/call", params: request.params }, CallToolResultSchema, {
          signal: extra.signal,
          timeout: REQUEST_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          ...(progressToken !== undefined
            ? {
                onprogress: (progress) => {
                  extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: { ...progress, progressToken },
                    })
                    .catch(() => {});
                },
              }
            : {}),
        }),
      );
    } catch (error) {
      if (isUnauthorized(error)) {
        return { content: [{ type: "text" as const, text: authMessage() }], isError: true };
      }
      forward(error);
    }
  }));

  const stdio = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MAX_STDIN_MESSAGE_BYTES,
  });
  stdio.onclose = () => void shutdown();
  process.stdin.on("end", () => {
    ending = true;
    if (pending === 0) setImmediate(() => void shutdown());
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await server.connect(stdio);
}

main().catch((error) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
