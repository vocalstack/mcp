# @vocalstack/mcp

[![vocalstack/mcp MCP server](https://vocalstack.com/badges/glama-server.svg)](https://glama.ai/mcp/servers/vocalstack/mcp)
[![VocalStack MCP connector](https://vocalstack.com/badges/glama-connector.svg)](https://glama.ai/mcp/connectors/com.vocalstack/mcp)
[![mcptry](https://mcptry.com/badge/com.vocalstack/mcp)](https://mcptry.com/servers/com.vocalstack/mcp)

VocalStack's MCP server. It runs on your machine (stdio) and works with VocalStack's public API using your API key, so any MCP client can transcribe, translate, search and summarize audio and video, and run live broadcasts that listeners follow in their own language.

## API key

Create a key at [app.vocalstack.com](https://app.vocalstack.com) under **Developers → API keys**, and pass it as `VOCALSTACK_API_KEY`. Without a key the server still starts and lists its tools, but every tool call asks you to set one.

Only transcription is billed, per second of audio. Reading, searching, summaries, translations and listeners are free.

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

Add the same block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

### Windsurf

Add the same block to `~/.codeium/windsurf/mcp_config.json`, then refresh the MCP servers in Windsurf's settings.

### Claude Code

```sh
claude mcp add vocalstack -e VOCALSTACK_API_KEY=your-api-key -- npx -y @vocalstack/mcp
```

### Hosted alternative

Clients that support remote MCP servers can use VocalStack's hosted endpoint instead, with no install and no API key: add `https://api.vocalstack.com/v1/mcp` and sign in with your VocalStack account when the client asks. In Claude Code:

```sh
claude mcp add --transport http vocalstack https://api.vocalstack.com/v1/mcp
```

Both offer the same tools.

## Tools

<!-- tools -->
- `create_transcription`: Start transcribing a finished recording, from a public link or a file sent inline; returns a transcriptionId at once, before any text.
- `get_transcription`: Read or export one transcription: its status and text with timestamps and speakers, its title and summary, or the whole transcript as an SRT, WebVTT or Markdown file; as spoken or translated, at once or after waiting for it to finish.
- `list_transcriptions`: List this account's transcriptions, newest first, a page at a time: files, links and live ones, including those broadcasts recorded.
- `search_transcriptions`: Find what was said across this account's transcriptions, or in one: the lines with given words or a name (mode words), or the passages that answer a question (mode meaning).
- `update_transcription`: Change a transcription: its name, its public share link, its summary, whether spoken translations use the speakers' own cloned voices, or bring it back from the trash.
- `delete_transcription`: Move a transcription to the trash, with its recordings, transcript, translations and summary; its share links stop working.
- `list_speakers`: List the speakers this account has saved: people recognised by name in every new transcription.
- `update_speaker`: Name or save a speaker: name one person in one transcription (instead of "Speaker N") and optionally save them so later transcriptions recognise them, or rename a saved speaker and switch their cloned voice on or off, everywhere they are recognised.
- `delete_speaker`: Delete a saved speaker for good: their name, fingerprint, stored sample and any cloned voice are erased at once and cannot be restored.
- `list_broadcasts`: List this account's broadcasts, or get one in detail.
- `start_broadcast`: Start live transcription and translation of a stream playing now, on a public link listeners open in their own language; or set up a broadcast and its link ahead of the event.
- `update_broadcast`: Change a broadcast's settings: its name, who can listen (public, or private behind a listener code VocalStack makes), the language spoken, and whether translations are read aloud, in stock or the speakers' own cloned voices; or bring it back from the trash.
- `stop_broadcast`: Stop the live transcription a broadcast is running, which also stops its billing.
- `delete_broadcast`: Move a broadcast to the trash: its public link and stream addresses stop working for listeners.
- `get_account`: Check the account's credit and usage: the balance left, the plan, whether a new file or live transcription would start now (and what would refuse it), and this period's limits.
<!-- /tools -->

Errors come back as tool results with `isError` set and a body with `error` (a code such as `not_found`, `invalid_options`, `invalid_state`, `insufficient_credit` or `rate_limited`), `message`, `retryable`, `retryAfterS` and `topUpUrl` when credit is needed. Retry a start with the same `idempotencyKey` so nothing is made or billed twice.

## Settings

| Variable | Meaning |
| --- | --- |
| `VOCALSTACK_API_KEY` | Your API key. |
| `VOCALSTACK_API_URL` | Another API address, for testing. Defaults to `https://api.vocalstack.com`. |

## Development

```sh
npm ci
npm test            # builds, then runs the tests against a fake API
npm run sync-tools  # refreshes src/tools.json (and the list above) from VocalStack's published tool definitions
npm run smoke       # starts the built server with no key and checks its tools against tools.json and the published list
```

Tool names, descriptions and argument schemas live in `src/tools.json` and are kept identical to the hosted server's; `src/handlers.ts` implements each one on the REST API. A daily check fails when they drift apart.

## License

MIT
