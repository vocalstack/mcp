# Installing the VocalStack MCP server

VocalStack transcribes and translates audio, video and live streams in about 100 languages, with speaker labels, and runs live broadcasts that listeners follow in their own language. There are two ways to connect; both offer the same fifteen tools. Pick one.

## Option A: hosted server (no install, sign in with OAuth)

Use this when the MCP client supports remote servers over streamable HTTP with OAuth.

- URL: `https://api.vocalstack.com/v1/mcp`
- Transport: streamable HTTP
- Auth: OAuth 2.1. The client discovers it from the server's `WWW-Authenticate` header (protected-resource metadata at `https://api.vocalstack.com/.well-known/oauth-protected-resource/v1/mcp`); the user signs in with their VocalStack account in the browser when asked.
- Alternatively, a client that cannot do OAuth can send an API key as the header `Authorization: Bearer <VOCALSTACK_API_KEY>`.

Example for clients that take a remote server entry (Cline `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "vocalstack": {
      "type": "streamableHttp",
      "url": "https://api.vocalstack.com/v1/mcp"
    }
  }
}
```

With an API key instead of OAuth:

```json
{
  "mcpServers": {
    "vocalstack": {
      "type": "streamableHttp",
      "url": "https://api.vocalstack.com/v1/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_VOCALSTACK_API_KEY"
      }
    }
  }
}
```

## Option B: local stdio server with npx

Requires Node.js 20 or later. Nothing needs to be cloned or built; `npx` downloads the published package `@vocalstack/mcp`.

1. Ask the user for a VocalStack API key. They create one at https://app.vocalstack.com under **Developers → API keys**. Do not invent one.
2. Add this entry to the MCP settings file (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "vocalstack": {
      "command": "npx",
      "args": ["-y", "@vocalstack/mcp"],
      "env": {
        "VOCALSTACK_API_KEY": "YOUR_VOCALSTACK_API_KEY"
      }
    }
  }
}
```

Without a key the server still starts and lists its tools, but every tool call returns an error asking for `VOCALSTACK_API_KEY`.

Optional: `VOCALSTACK_API_URL` points the server at another API address (for testing); the default is `https://api.vocalstack.com`.

## Check that it works

Call `get_account`. It returns the account's balance, plan and whether a new transcription would start. If it says credit is needed, the response includes a `topUpUrl` for the user.

## Billing

Only transcription is billed, per second of audio, from the account's VocalStack credit. Reading, searching, summaries, translations and listeners are free.

## Help

Docs: https://api.vocalstack.com/docs/agents. Support: support@vocalstack.com.
