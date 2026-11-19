# @vocalstack/mcp

[![VocalStack MCP connector](https://glama.ai/mcp/connectors/com.vocalstack/mcp/badges/score.svg)](https://glama.ai/mcp/connectors/com.vocalstack/mcp)

A local bridge to VocalStack's hosted MCP server. Use it in MCP clients that only run local (stdio) servers, such as Claude Desktop, Cursor and Windsurf, to transcribe, translate, search and summarize audio and video, and to run live broadcasts.

If your client supports remote MCP servers, you don't need this package: add `https://api.vocalstack.com/v1/mcp` as a remote server and sign in with your VocalStack account when asked. Nothing to install.

## API key

Create a key at [app.vocalstack.com](https://app.vocalstack.com) under **Developers → API keys**, and pass it as `VOCALSTACK_API_KEY`. Without a key the server still starts and lists its tools, but every tool call asks you to set one.

## Setup

Requires Node.js 20 or later.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "vocalstack": {
      "command": "npx",
      "args": ["-y", "@vocalstack/mcp"],
      "env": {
        "VOCALSTACK_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add this to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "vocalstack": {
      "command": "npx",
      "args": ["-y", "@vocalstack/mcp"],
      "env": {
        "VOCALSTACK_API_KEY": "your-api-key"
      }
    }
  }
}
```

Windsurf and other clients take the same `command`, `args` and `env`.

### Claude Code

```sh
claude mcp add vocalstack -e VOCALSTACK_API_KEY=your-api-key -- npx -y @vocalstack/mcp
```

Claude Code also supports remote servers directly:

```sh
claude mcp add --transport http vocalstack https://api.vocalstack.com/v1/mcp
```

### Remote, no install

In clients that support remote MCP servers, add:

```
https://api.vocalstack.com/v1/mcp
```

The client opens a VocalStack sign-in page the first time it needs it.

## Tools

The tools come from VocalStack's hosted server, so the list is always current without updating this package. Ask your assistant what VocalStack can do, or see [vocalstack.com](https://vocalstack.com/).

## Settings

| Variable | Meaning |
| --- | --- |
| `VOCALSTACK_API_KEY` | Your API key. |
| `VOCALSTACK_MCP_URL` | Another server address, for testing. Defaults to `https://api.vocalstack.com/v1/mcp`. |

## License

MIT
