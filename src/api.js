// REST client for the public BotGathering HTTP API (https://botgathering.com/api).
// This is the data backend of the MCP server, the same way the GitHub MCP server
// wraps api.github.com. It only ever calls the JSON API and the recipe markdown
// pages; it never talks to a remote MCP endpoint.

export const DEFAULT_BASE_URL = "https://botgathering.com";

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status; // HTTP status, or 0 for network errors / timeouts
    this.body = body;     // parsed JSON body when available
  }
  get isNetwork() { return this.status === 0; }
}

export class BotGatheringApi {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 20000, userAgent = "botgathering-mcp", fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.fetch = fetchImpl;
  }

  async request(method, path, { query, body, apiKey, accept = "application/json" } = {}) {
    if (!path.startsWith("/") || /^\/mcp(\/|$|\?)/.test(path)) throw new Error(`refusing to call ${path}: only REST paths are allowed`);
    let url = this.baseUrl + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }
    const headers = { Accept: accept, "User-Agent": this.userAgent };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res, text;
    try {
      res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      const why = e.name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : (e.cause?.code || e.message);
      throw new ApiError(0, `could not reach ${this.baseUrl} (${why})`);
    } finally {
      clearTimeout(timer);
    }
    const isJson = (res.headers.get("content-type") || "").includes("json");
    let json;
    if (isJson && text) { try { json = JSON.parse(text); } catch { /* keep text */ } }
    if (!res.ok) {
      const msg = (json && (json.error || json.message)) || text.slice(0, 300) || res.statusText;
      throw new ApiError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg), json);
    }
    return { status: res.status, json, text };
  }

  // ---- read endpoints (no key) ----
  searchRecipes({ q, category, tag, sort, limit, page, offset } = {}) {
    return this.request("GET", "/api/recipes", { query: { q, category, tag, sort, limit, page, offset } }).then((r) => r.json);
  }
  getRecipeJson(slug) { return this.request("GET", `/api/recipes/${encodeURIComponent(slug)}`).then((r) => r.json); }
  getRecipeMarkdown(slug) {
    return this.request("GET", `/recipe/${encodeURIComponent(slug)}.md`, { accept: "text/markdown, text/plain" }).then((r) => r.text);
  }
  listCategories() { return this.request("GET", "/api/categories").then((r) => r.json); }

  // ---- account endpoints ----
  me(apiKey) { return this.request("GET", "/api/me", { apiKey }).then((r) => r.json); }
  register(body) { return this.request("POST", "/api/bots/register", { body }).then((r) => r.json); }
  requestVerificationEmail(apiKey, email) { return this.request("POST", "/api/bots/verify-email", { apiKey, body: { email } }).then((r) => r.json); }
  rename(apiKey, body) { return this.request("POST", "/api/bots/rename", { apiKey, body }).then((r) => r.json); }
  verifyLegacyCode(email, code) { return this.request("POST", "/api/bots/verify", { body: { email, code } }).then((r) => r.json); }

  // ---- write endpoints ----
  download(slug, apiKey, body = {}) {
    return this.request("POST", `/api/recipes/${encodeURIComponent(slug)}/download`, { apiKey, body }).then((r) => r.json);
  }
  report(apiKey, body) { return this.request("POST", "/api/report", { apiKey, body }).then((r) => r.json); }
  quickReport(slug, body, apiKey) {
    return this.request("POST", `/api/recipes/${encodeURIComponent(slug)}/quick-report`, { apiKey, body }).then((r) => r.json);
  }
}
