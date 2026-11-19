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
- `transcribe_url`: Start transcribing a recording at a public link: a direct audio or video file, a podcast episode, a YouTube video, or a public post on Vimeo, TikTok, X, SoundCloud or another site listed under url.
- `transcribe_file`: Start transcribing an audio or video file you hold, sent whole as base64 in fileBase64 (at most 10 MiB once decoded; mp3, m4a, wav, mp4, webm and other common formats).
- `get_transcription`: Read one transcription: its status and its text with timestamps and speakers.
- `wait_for_transcription`: Block until a file or link transcription (from transcribe_url or transcribe_file) finishes, for at most timeoutS seconds (default 50, at most 60), then return its status.
- `list_transcriptions`: List this account's transcriptions, newest first, one page at a time.
- `search_transcriptions`: Find the lines where given words were said, across all of this account's transcriptions or within one (transcriptionId).
- `search_by_meaning`: Find the passages of this account's transcriptions closest in meaning to a question or topic, in any language, even when they share none of its words (vector search).
- `get_summary`: Get the title and summary of a finished transcription, written from its whole text.
- `translate_transcription`: Get a finished transcription translated into another language, as readable text or timed segments, in the same shape as get_transcription.
- `list_voices`: List the voices that can read translations aloud in one language: stock voices and this account's own cloned voices.
- `list_speakers`: List the speakers this account saved: the people it has named, so they are recognised by name in later transcriptions.
- `list_broadcasts`: List this account's broadcasts: live events listeners follow at a public link, reading (or hearing) what is said, translated into their own language as it is spoken; each listener picks from up to 10 languages, free, with no app or sign-up.
- `get_broadcast`: Get one broadcast in detail.
- `start_broadcast`: Start live transcription and translation of a live stream (a YouTube live, an internet radio station, an HLS .m3u8 or Icecast stream) on a broadcast: a new one, or an existing one when broadcastId is set (its link stays the same).
- `stop_broadcast`: Stop the live transcription a broadcast is running, which also stops its billing.
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
