# @vocalstack/mcp

[![vocalstack/mcp MCP server](https://glama.ai/mcp/servers/vocalstack/mcp/badges/score.svg)](https://glama.ai/mcp/servers/vocalstack/mcp)
[![VocalStack MCP connector](https://glama.ai/mcp/connectors/com.vocalstack/mcp/badges/score.svg)](https://glama.ai/mcp/connectors/com.vocalstack/mcp)
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
- `transcribe_url`: Start transcribing audio or video at a public URL (a file link, a podcast episode, a YouTube video, a Vimeo, TikTok, X or SoundCloud post…).
- `transcribe_file`: Start transcribing an audio or video file you have, sent as base64 (at most 10 MiB decoded).
- `get_transcription`: Get a transcription's status and its text with timestamps and speakers: the whole text once it is done, or the text so far while a file is transcribing or a live transcription is on air (partial is true).
- `wait_for_transcription`: Wait for a file or link transcription to finish, up to 60 seconds per call.
- `list_transcriptions`: List this account's transcriptions, newest first, with their status: files and links (kind file) and live transcriptions, including those of broadcasts (kind live).
- `search_transcriptions`: Search what was said across this account's transcriptions, in any language.
- `search_by_meaning`: Find the passages of this account's transcriptions closest in meaning to a question or topic, in any language, even when they share none of its words (vector search).
- `get_summary`: Get the title and summary of a finished transcription, optionally in another language (when it was made with summaryTranslations).
- `translate_transcription`: Get a finished transcription, from a file, a link or a live broadcast, translated into another language, as text or timed segments.
- `list_voices`: List the voices that can speak a language: id, name, gender and accent when known, and a quality rating.
- `list_speakers`: List the speakers this account saved: the people recognised by name in its transcriptions.
- `list_broadcasts`: List this account's broadcasts: live events listeners follow at a public link, reading (or hearing) what is said, translated into their own language as it is spoken; each listener picks from up to 10 languages, free, with no app or sign-up.
- `get_broadcast`: Get one broadcast: its public link, whether it is on air and since when, how many are listening, the live transcription it is showing (read it with get_transcription) and its earlier ones, and the streams it can record.
- `start_broadcast`: Start live transcription and translation of a live stream (a YouTube live, an internet radio station, an HLS or Icecast stream) on a broadcast.
- `stop_broadcast`: Stop the live transcription a broadcast is running.
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
