#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, randomBytes, createHash } from "node:crypto";

// ── Configuration ─────────────────────────────────────────────────────
const VERSION = "1.1.0";
const DEFAULT_PORT = 3001;
const MAX_RESPONSE_CHARS = 80_000; // ~25k tokens

const args = process.argv.slice(2);
const transportMode = args.includes("--transport")
  ? args[args.indexOf("--transport") + 1]
  : "stdio";
const portFlag = args.includes("--port")
  ? parseInt(args[args.indexOf("--port") + 1], 10)
  : DEFAULT_PORT;
const port = Number.isFinite(portFlag) ? portFlag : DEFAULT_PORT;

const apiKey = process.env.FOGLIFT_API_KEY || "";
const baseUrl = (process.env.FOGLIFT_BASE_URL || "https://foglift.io").replace(
  /\/$/,
  ""
);

// ── Helpers ───────────────────────────────────────────────────────────

function makeHeaders(token?: string): Record<string, string> {
  const key = token || apiKey;
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) {
    h["Authorization"] = `Bearer ${key}`;
    h["X-API-Key"] = key;
  }
  return h;
}

async function callApi(
  method: "GET" | "POST" | "DELETE",
  path: string,
  query?: Record<string, string | undefined>,
  body?: unknown,
  token?: string
): Promise<unknown> {
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const opts: RequestInit = { method, headers: makeHeaders(token) };
  if (body !== undefined && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), opts);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) return { error: true, status: res.status, body: data };
  return data;
}

function truncateJson(data: unknown): string {
  const json = JSON.stringify(data, null, 2);
  if (json.length <= MAX_RESPONSE_CHARS) return json;
  return (
    json.slice(0, MAX_RESPONSE_CHARS) +
    "\n\n... [Response truncated. Use pagination parameters or filters to narrow results.]"
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: truncateJson(data) }],
  };
}

// ── OAuth 2.0 State ───────────────────────────────────────────────────

interface AuthCode {
  apiKey: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, string>(); // token -> apiKey

const OAUTH_ALLOWED_CALLBACKS = [
  "http://localhost:6274/oauth/callback",
  "http://localhost:6274/oauth/callback/debug",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

// ── MCP Server ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "foglift",
  version: VERSION,
});

// 1. scan_website
server.tool(
  "scan_website",
  "Scan a website URL for SEO, GEO, and AI search readiness. Returns overall score, category scores (technical SEO, content quality, AI optimization, schema markup), and a list of specific issues with fix suggestions.",
  { url: z.string().describe("The full URL to scan (e.g. https://example.com)") },
  {
    title: "Scan Website",
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ url }) => callApi("GET", "/api/v1/scan", { url, format: "json" }).then(textResult)
);

// 2. batch_scan
server.tool(
  "batch_scan",
  "Scan multiple URLs in one request (max 10). Returns scores and issues for each URL. Requires API key.",
  {
    urls: z.array(z.string()).max(10).describe("Array of URLs to scan (max 10)"),
  },
  {
    title: "Batch Scan Websites",
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ urls }) =>
    callApi("POST", "/api/v1/scan/batch", undefined, { urls }).then(textResult)
);

// 3. run_ai_visibility
server.tool(
  "run_ai_visibility",
  "Run an AI visibility check — query AI models (ChatGPT, Claude, Perplexity, Gemini) with prompts related to your domain and see if they mention or recommend your brand. Returns per-model results with citation status and sentiment.",
  {
    domain: z.string().describe("The domain to check (e.g. example.com)"),
    prompts: z.array(z.string()).optional().describe("Custom prompts to test"),
    models: z
      .array(z.string())
      .optional()
      .describe("Models to test (e.g. chatgpt, claude, perplexity, gemini)"),
    use_saved_prompts: z.boolean().optional().describe("Use previously saved prompts"),
  },
  {
    title: "Run AI Visibility Check",
    destructiveHint: false,
    openWorldHint: true,
  },
  async ({ domain, prompts, models, use_saved_prompts }) => {
    const body: Record<string, unknown> = { domain };
    if (prompts) body.prompts = prompts;
    if (models) body.models = models;
    if (use_saved_prompts !== undefined) body.use_saved_prompts = use_saved_prompts;
    return callApi("POST", "/api/v1/ai-visibility", undefined, body).then(textResult);
  }
);

// 4. get_ai_results
server.tool(
  "get_ai_results",
  "Get historical AI visibility results for your domain. Shows how AI models have mentioned your brand over time, with sentiment and citation data.",
  {
    days: z.number().optional().describe("Number of days of history (default 30)"),
    model: z.string().optional().describe("Filter by model name"),
    prompt: z.string().optional().describe("Filter by prompt text"),
    page: z.number().optional().describe("Page number for pagination"),
    limit: z.number().optional().describe("Results per page (default 20)"),
  },
  {
    title: "Get AI Visibility Results",
    readOnlyHint: true,
  },
  async ({ days, model, prompt, page, limit }) =>
    callApi("GET", "/api/v1/ai-visibility/results", {
      days: days?.toString(),
      model,
      prompt,
      page: page?.toString(),
      limit: limit?.toString(),
    }).then(textResult)
);

// 5. get_prompts
server.tool(
  "get_prompts",
  "Get your saved AI visibility monitoring prompts. These are the prompts used to check if AI models mention your brand.",
  {},
  {
    title: "Get Monitoring Prompts",
    readOnlyHint: true,
  },
  async () => callApi("GET", "/api/v1/prompts").then(textResult)
);

// 6. add_prompt
server.tool(
  "add_prompt",
  "Add a new prompt to monitor for AI visibility. The prompt will be periodically tested against AI models to check if they mention your brand.",
  {
    prompt: z.string().describe("The prompt text to save"),
    category: z.string().optional().describe("Category for the prompt"),
  },
  {
    title: "Add Monitoring Prompt",
    destructiveHint: false,
  },
  async ({ prompt, category }) => {
    const body: Record<string, unknown> = { prompt };
    if (category) body.category = category;
    return callApi("POST", "/api/v1/prompts", undefined, body).then(textResult);
  }
);

// 7. delete_prompt
server.tool(
  "delete_prompt",
  "Delete a saved AI visibility monitoring prompt by its ID.",
  {
    prompt_id: z.string().describe("The ID of the prompt to delete"),
  },
  {
    title: "Delete Monitoring Prompt",
    destructiveHint: true,
  },
  async ({ prompt_id }) =>
    callApi("DELETE", "/api/v1/prompts", undefined, { prompt_id }).then(textResult)
);

// 8. get_models
server.tool(
  "get_models",
  "Get your enabled AI models and monitoring frequency settings.",
  {},
  {
    title: "Get AI Model Settings",
    readOnlyHint: true,
  },
  async () => callApi("GET", "/api/v1/models").then(textResult)
);

// 9. set_models
server.tool(
  "set_models",
  "Update which AI models are enabled for monitoring and the monitoring frequency.",
  {
    enabled_models: z
      .record(z.boolean())
      .optional()
      .describe('Map of model names to enabled status (e.g. {"chatgpt": true, "claude": false})'),
    monitoring_frequency: z
      .string()
      .optional()
      .describe("Monitoring frequency: daily, weekly, or monthly"),
  },
  {
    title: "Update AI Model Settings",
    destructiveHint: false,
    idempotentHint: true,
  },
  async ({ enabled_models, monitoring_frequency }) => {
    const body: Record<string, unknown> = {};
    if (enabled_models) body.enabled_models = enabled_models;
    if (monitoring_frequency) body.monitoring_frequency = monitoring_frequency;
    return callApi("POST", "/api/v1/models", undefined, body).then(textResult);
  }
);

// 10. get_sentiment
server.tool(
  "get_sentiment",
  "Get AI sentiment analysis results — shows how AI models talk about your brand (positive, neutral, negative) with trends over time.",
  {
    days: z.number().optional().describe("Number of days of history"),
    model: z.string().optional().describe("Filter by model name"),
  },
  {
    title: "Get Brand Sentiment",
    readOnlyHint: true,
  },
  async ({ days, model }) =>
    callApi("GET", "/api/v1/sentiment", {
      days: days?.toString(),
      model,
    }).then(textResult)
);

// 11. get_usage
server.tool(
  "get_usage",
  "Get API usage statistics for your Foglift account — scan count, AI visibility checks, and quota remaining.",
  {},
  {
    title: "Get API Usage",
    readOnlyHint: true,
  },
  async () => callApi("GET", "/api/v1/usage").then(textResult)
);

// 12. get_scan_history
server.tool(
  "get_scan_history",
  "Get historical scan results for a specific URL — shows how scores have changed over time.",
  {
    url: z.string().describe("The URL to get scan history for"),
  },
  {
    title: "Get Scan History",
    readOnlyHint: true,
  },
  async ({ url }) =>
    callApi("GET", "/api/v1/scan-history", { url }).then(textResult)
);

// 13. get_geo_monitor
server.tool(
  "get_geo_monitor",
  "Get GEO monitoring data — track how your site's AI search optimization scores change over time.",
  {
    days: z.number().optional().describe("Number of days of history"),
  },
  {
    title: "Get GEO Monitor",
    readOnlyHint: true,
  },
  async ({ days }) =>
    callApi("GET", "/api/v1/geo-monitor", { days: days?.toString() }).then(textResult)
);

// ── OAuth Helpers ─────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function verifyPkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method === "S256") return sha256(codeVerifier) === codeChallenge;
  if (method === "plain") return codeVerifier === codeChallenge;
  return false;
}

function oauthError(res: ServerResponse, status: number, error: string, description: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error, error_description: description }));
}

function serveAuthorizePage(res: ServerResponse, params: URLSearchParams) {
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const state = params.get("state") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "plain";

  if (!redirectUri || !OAUTH_ALLOWED_CALLBACKS.includes(redirectUri)) {
    oauthError(res, 400, "invalid_request", "Invalid or disallowed redirect_uri");
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Foglift MCP</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: white; border-radius: 12px; padding: 2rem; max-width: 420px; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    label { display: block; font-weight: 500; margin-bottom: 0.5rem; font-size: 0.9rem; }
    input[type="text"] { width: 100%; padding: 0.6rem 0.8rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.95rem; margin-bottom: 1rem; }
    button { width: 100%; padding: 0.7rem; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; font-weight: 500; }
    button:hover { background: #1d4ed8; }
    .help { margin-top: 1rem; font-size: 0.8rem; color: #888; text-align: center; }
    .help a { color: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Foglift</h1>
    <p class="subtitle">Enter your Foglift API key to connect.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <label for="api_key">API Key</label>
      <input type="text" id="api_key" name="api_key" placeholder="sk_fog_..." required autocomplete="off">
      <button type="submit">Authorize</button>
    </form>
    <p class="help">Get your API key at <a href="https://foglift.io/dashboard" target="_blank">foglift.io/dashboard</a></p>
  </div>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function handleAuthorizePost(res: ServerResponse, body: string) {
  const params = new URLSearchParams(body);
  const inputApiKey = params.get("api_key") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const state = params.get("state") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "plain";

  if (!inputApiKey) {
    oauthError(res, 400, "invalid_request", "API key is required");
    return;
  }
  if (!redirectUri || !OAUTH_ALLOWED_CALLBACKS.includes(redirectUri)) {
    oauthError(res, 400, "invalid_request", "Invalid redirect_uri");
    return;
  }

  const code = randomBytes(32).toString("hex");
  authCodes.set(code, {
    apiKey: inputApiKey,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) callbackUrl.searchParams.set("state", state);

  res.writeHead(302, { Location: callbackUrl.toString() });
  res.end();
}

function handleTokenRequest(res: ServerResponse, body: string) {
  const params = new URLSearchParams(body);
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code") || "";
    const codeVerifier = params.get("code_verifier") || "";

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      authCodes.delete(code);
      oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
      return;
    }

    if (stored.codeChallenge && !verifyPkce(codeVerifier, stored.codeChallenge, stored.codeChallengeMethod)) {
      oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      return;
    }

    authCodes.delete(code);

    const token = randomBytes(32).toString("hex");
    accessTokens.set(token, stored.apiKey);

    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        access_token: token,
        token_type: "Bearer",
        scope: "foglift:read foglift:write",
      })
    );
    return;
  }

  oauthError(res, 400, "unsupported_grant_type", `Grant type "${grantType}" is not supported`);
}

// ── HTTP Transport ────────────────────────────────────────────────────

function resolveApiKey(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader) return apiKey || undefined;
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  // Check if it's an OAuth-issued token
  const mapped = accessTokens.get(bearer);
  if (mapped) return mapped;
  // Otherwise treat the bearer value as a direct API key
  return bearer;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

async function startHttpServer() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const origin = `http://localhost:${port}`;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", origin);
    const pathname = url.pathname;

    // OAuth discovery
    if (pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256", "plain"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      );
      return;
    }

    // OAuth authorize
    if (pathname === "/oauth/authorize") {
      if (req.method === "GET") {
        serveAuthorizePage(res, url.searchParams);
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        handleAuthorizePost(res, body);
        return;
      }
    }

    // OAuth token
    if (pathname === "/oauth/token" && req.method === "POST") {
      const body = await readBody(req);
      handleTokenRequest(res, body);
      return;
    }

    // MCP endpoint
    if (pathname === "/mcp") {
      // Inject resolved API key into the process environment for this request
      const resolved = resolveApiKey(req);
      if (resolved) {
        // The callApi function reads from the module-level apiKey,
        // but for HTTP mode we set it per-request via a header override.
        // For simplicity, set the global for the duration of this request.
        // In production, this should be request-scoped.
        (req as IncomingMessage & { auth?: { token: string } }).auth = {
          token: resolved,
        };
      }

      try {
        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    // Health check
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: VERSION }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    console.log(`Foglift MCP server v${VERSION} running on http://localhost:${port}/mcp`);
    console.log(`OAuth authorize: http://localhost:${port}/oauth/authorize`);
    console.log(`Health check:    http://localhost:${port}/health`);
  });
}

// ── Stdio Transport ───────────────────────────────────────────────────

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Foglift MCP server v${VERSION} running on stdio`);
}

// ── Entry Point ───────────────────────────────────────────────────────

async function main() {
  if (transportMode === "http") {
    await startHttpServer();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
