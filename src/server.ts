import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Api } from "./api.js";
import { Args } from "./args.js";
import { ToolError } from "./errors.js";
import { handlers, type Context } from "./handlers.js";
import { KEY_MISSING, toolError, toolOk, toolText } from "./result.js";

export interface Definitions {
  instructions: string;
  tools: Tool[];
}

export const definitions: Definitions = JSON.parse(readFileSync(new URL("./tools.json", import.meta.url), "utf8"));

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface Options {
  apiKey?: string;
  baseUrl?: string;
}

export function createServer(options: Options): Server {
  const baseUrl = options.baseUrl || "https://api.vocalstack.com";
  const api = options.apiKey ? new Api(baseUrl, options.apiKey, `vocalstack-mcp/${VERSION}`) : undefined;
  const byName = new Map(definitions.tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "vocalstack", version: VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: definitions.instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const tool = byName.get(name);
    const handler = handlers[name];
    if (!tool || !handler) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${JSON.stringify(name)}`);
    if (!api) return toolText(KEY_MISSING);
    const token = request.params._meta?.progressToken;
    const ctx: Context = { api, signal: extra.signal };
    if (token !== undefined) {
      ctx.progress = (progress, total, message) =>
        extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total, message } });
    }
    try {
      const args = Args.parse(tool.inputSchema as never, request.params.arguments);
      return toolOk(await handler(args, ctx));
    } catch (e) {
      if (e instanceof ToolError) return toolError(e);
      return toolError(new ToolError("internal", e instanceof Error ? e.message : String(e)));
    }
  });

  return server;
}
