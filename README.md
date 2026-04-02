# foglift-mcp

MCP server for [Foglift](https://foglift.io) — scan websites for SEO, GEO, and AI search readiness directly from AI assistants like Claude, Cursor, and Windsurf.

Foglift helps you understand how AI models (ChatGPT, Claude, Perplexity, Gemini) see your website. This MCP server exposes 13 tools that let AI assistants scan your site, monitor your AI visibility, track brand sentiment, and more.

## Quick Start

### Install via npm

```bash
npm install -g foglift-mcp
```

### Run without installing

```bash
npx foglift-mcp
```

### Run as HTTP server (for remote/Claude.ai use)

```bash
npx foglift-mcp --transport http --port 3001
```

### Docker

```dockerfile
FROM node:20-slim
RUN npm install -g foglift-mcp
ENV FOGLIFT_API_KEY=sk_fog_your_key_here
EXPOSE 3001
CMD ["foglift-mcp", "--transport", "http", "--port", "3001"]
```

```bash
docker build -t foglift-mcp .
docker run -p 3001:3001 -e FOGLIFT_API_KEY=sk_fog_... foglift-mcp
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FOGLIFT_API_KEY` | Yes (for most tools) | Your Foglift API key (`sk_fog_...`). Get one at [foglift.io/dashboard](https://foglift.io/dashboard) |
| `FOGLIFT_BASE_URL` | No | Override the API base URL (default: `https://foglift.io`) |

### Claude Desktop / Claude Code (stdio)

Add to your MCP config (`~/.claude/mcp.json` for Claude Code, or `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "foglift": {
      "command": "npx",
      "args": ["-y", "foglift-mcp"],
      "env": {
        "FOGLIFT_API_KEY": "sk_fog_your_key_here"
      }
    }
  }
}
```

### Claude.ai (remote HTTP with OAuth)

When running as a remote MCP server, Foglift supports OAuth 2.0 with PKCE for authentication. Users authorize by entering their Foglift API key through a secure browser flow.

Start the server:

```bash
FOGLIFT_API_KEY="" foglift-mcp --transport http --port 3001
```

The server exposes these OAuth endpoints:

- `GET /.well-known/oauth-authorization-server` — OAuth discovery metadata
- `GET /oauth/authorize` — Authorization page (user enters API key)
- `POST /oauth/token` — Token exchange endpoint
- `POST /mcp` — MCP message endpoint

### Cursor / Windsurf

Add to `.cursor/mcp.json` (Cursor) or `.windsurf/mcp.json` (Windsurf) in your project root:

```json
{
  "mcpServers": {
    "foglift": {
      "command": "npx",
      "args": ["-y", "foglift-mcp"],
      "env": {
        "FOGLIFT_API_KEY": "sk_fog_your_key_here"
      }
    }
  }
}
```

## Available Tools

### Read-only tools

| Tool | Description |
|---|---|
| `get_ai_results` | Get historical AI visibility results |
| `get_prompts` | List saved monitoring prompts |
| `get_models` | Get enabled AI models and monitoring frequency |
| `get_sentiment` | Get AI sentiment analysis for your brand |
| `get_usage` | Get API usage statistics |
| `get_scan_history` | Get historical scan results for a URL |
| `get_geo_monitor` | Get GEO monitoring data over time |

### Write tools

| Tool | Description |
|---|---|
| `scan_website` | Scan a URL for SEO, GEO, and AI readiness scores |
| `batch_scan` | Scan up to 10 URLs in one request |
| `run_ai_visibility` | Check how AI models mention your brand |
| `add_prompt` | Add a new monitoring prompt |
| `set_models` | Update enabled models and frequency |

### Destructive tools

| Tool | Description |
|---|---|
| `delete_prompt` | Delete a saved monitoring prompt |

## Usage Examples

### Example 1: Scan a website and get optimization advice

**Prompt:** "Scan my website https://example.com and tell me how it scores for AI search readiness"

The assistant calls `scan_website` with your URL and receives:

```json
{
  "overall_score": 62,
  "categories": {
    "technical_seo": { "score": 78, "issues": 3 },
    "content_quality": { "score": 71, "issues": 5 },
    "ai_optimization": { "score": 45, "issues": 8 },
    "schema_markup": { "score": 54, "issues": 4 }
  },
  "top_issues": [
    { "severity": "high", "message": "Missing FAQ schema markup", "fix": "Add FAQPage structured data" },
    { "severity": "high", "message": "No clear entity definitions", "fix": "Add Organization schema with sameAs links" }
  ]
}
```

The assistant then explains your scores and provides specific recommendations to improve your AI visibility.

### Example 2: Check if ChatGPT mentions your brand

**Prompt:** "Check if ChatGPT and Claude mention my brand Acme Corp when people ask about project management tools"

The assistant calls `run_ai_visibility` with:
- `domain`: "acmecorp.com"
- `prompts`: ["What are the best project management tools?", "Recommend a project management platform for startups"]
- `models`: ["chatgpt", "claude"]

Response includes per-model results showing whether your brand was mentioned, the sentiment, and exact quotes from AI responses.

### Example 3: Review your monitoring setup and results

**Prompt:** "What prompts am I monitoring and what are the latest results?"

The assistant calls `get_prompts` to list your saved prompts, then calls `get_ai_results` to fetch recent results. It combines both to show you:
- Which prompts are being tracked
- Which AI models mentioned your brand
- Sentiment trends over time
- Prompts where your brand is missing (opportunities)

### Example 4: Track SEO progress over time

**Prompt:** "Show me how my site's GEO score has changed over the last 30 days"

The assistant calls `get_geo_monitor` with `days: 30` and presents a summary of score trends, highlighting improvements and regressions.

## Transport Modes

| Mode | Flag | Use Case |
|---|---|---|
| **stdio** (default) | none | Local use with Claude Code, Cursor, Windsurf |
| **HTTP** | `--transport http` | Remote server, Claude.ai integration |

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--transport` | `stdio` | Transport mode: `stdio` or `http` |
| `--port` | `3001` | HTTP server port (only used with `--transport http`) |

## Development

```bash
# Build
npm run build

# Run locally (stdio)
FOGLIFT_API_KEY=sk_fog_... node dist/index.js

# Run locally (HTTP)
FOGLIFT_API_KEY=sk_fog_... node dist/index.js --transport http --port 3001
```

## License

MIT
