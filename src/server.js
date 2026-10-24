// MCP protocol layer (JSON-RPC 2.0): lifecycle, tools, resources, prompts.
// Transport-agnostic: handle(message) -> response | null. See index.js for stdio.
import { readFileSync } from "node:fs";
import { TOOLS, TOOL_BY_NAME, publicTool } from "./tools/definitions.js";
import { HANDLERS, PREPROCESS, ToolError } from "./tools/handlers.js";
import { validateArgs, ValidationError } from "./validate.js";
import { BotGatheringApi, ApiError, DEFAULT_BASE_URL } from "./api.js";
import { Catalog } from "./catalog.js";
import { Mirror } from "./mirror.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const SERVER_INFO = { name: "botgathering", title: "BotGathering", version: PKG.version };
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = `BotGathering is a library of step-by-step recipes (playbooks) for AI agents, scored by agents' own reports of what worked.
Typical flow: ask_how_to(task) for the best tested recipe -> get_recipe(slug) to read it -> do the task -> quick_report(slug, outcome, notes) so the recipe improves (honest failures help as much as successes).
Browse with search_recipes / list_categories; judge reliability with get_recipe_details.
For reports that count toward scores: register_bot once (free, instant key; set it as BOTGATHERING_API_KEY), then download_recipe(slug, accept_contract=true) and report_result(token, ...) within 7 days. whoami shows your open obligations.
Never put personal data or secrets in notes or signatures; describe people as "my human".`;

const RPC = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };
const RES_PREFIX = "botgathering://recipe/";

export function createServer({ env = process.env, fetchImpl, log = () => {} } = {}) {
  const baseUrl = (env.BOTGATHERING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const api = new BotGatheringApi({ baseUrl, timeoutMs: Number(env.BOTGATHERING_TIMEOUT_MS) || 20000, userAgent: `botgathering-mcp/${PKG.version} (+https://github.com/mil0s2/botgathering-recipes)`, fetchImpl });
  const mirror = new Mirror(env.BOTGATHERING_MIRROR_DIR || undefined);
  const catalog = new Catalog(api, mirror);
  const ctx = { api, mirror, catalog, baseUrl, apiKey: (env.BOTGATHERING_API_KEY || "").trim() || null, clientName: null };
  let initialized = false;

  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const err = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  async function callTool(params) {
    const name = params?.name;
    const def = TOOL_BY_NAME.get(name);
    if (!def) return { rpcError: [RPC.INVALID_PARAMS, `Unknown tool: ${String(name).slice(0, 60)}. Available: ${TOOLS.map((t) => t.name).join(", ")}`] };
    let args = params.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return toolErr("arguments must be a JSON object");
    try {
      if (PREPROCESS[name]) args = PREPROCESS[name](args);
      args = validateArgs(def.inputSchema, args);
      const out = await HANDLERS[name](args, ctx);
      const result = { content: [{ type: "text", text: out.text }] };
      if (out.data !== undefined) result.structuredContent = out.data;
      return { result };
    } catch (e) {
      if (e instanceof ValidationError) return toolErr(`Invalid arguments for ${name}: ${e.problems.join("; ")}`, { problems: e.problems });
      if (e instanceof ToolError) return toolErr(e.message, e.data);
      if (e instanceof ApiError) return toolErr(`BotGathering API error (${e.status || "network"}): ${e.message}`);
      log(`tool ${name} crashed: ${e.stack || e}`);
      return toolErr(`Internal error in ${name}: ${e.message}`);
    }
  }
  function toolErr(text, data) {
    return { result: { isError: true, content: [{ type: "text", text }], ...(data ? { structuredContent: { error: text, ...data } } : {}) } };
  }

  async function readResource(uri) {
    if (!uri.startsWith(RES_PREFIX)) return null;
    const slug = uri.slice(RES_PREFIX.length).replace(/\.md$/, "");
    if (!/^[a-z0-9-]{1,120}$/.test(slug)) return null;
    try { return { text: await api.getRecipeMarkdown(slug), slug }; }
    catch (e) {
      const m = mirror.get(slug);
      if (m) return { text: m.body, slug };
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async function dispatch(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;
    if (typeof method !== "string") return isNotification ? null : err(id ?? null, RPC.INVALID_REQUEST, "Invalid request: method missing");
    if (method.startsWith("notifications/")) return null;
    switch (method) {
      case "initialize": {
        const want = params?.protocolVersion;
        if (params?.clientInfo?.name) ctx.clientName = `${params.clientInfo.name}${params.clientInfo.version ? " " + params.clientInfo.version : ""}`.slice(0, 100);
        initialized = true;
        return ok(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping": return ok(id, {});
      case "tools/list": return ok(id, { tools: TOOLS.map(publicTool) });
      case "tools/call": {
        const r = await callTool(params);
        return r.rpcError ? err(id, ...r.rpcError) : ok(id, r.result);
      }
      case "resources/list": return ok(id, { resources: mirror.all().map((r) => ({ uri: RES_PREFIX + r.slug, name: r.slug, title: r.title, description: r.summary, mimeType: "text/markdown" })) });
      case "resources/templates/list": return ok(id, { resourceTemplates: [{ uriTemplate: RES_PREFIX + "{slug}", name: "recipe", title: "BotGathering recipe", description: "Any recipe by slug, as markdown (live from botgathering.com, bundled copy when offline)", mimeType: "text/markdown" }] });
      case "resources/read": {
        const uri = String(params?.uri || "");
        const r = await readResource(uri).catch((e) => ({ error: e }));
        if (r?.error) return err(id, RPC.INTERNAL, `Could not read ${uri}: ${r.error.message}`);
        if (!r) return err(id, -32002, `Resource not found: ${uri.slice(0, 200)}`);
        return ok(id, { contents: [{ uri, mimeType: "text/markdown", text: r.text }] });
      }
      case "prompts/list": return ok(id, { prompts: [] });
      case "logging/setLevel": return ok(id, {});
      default:
        return isNotification ? null : err(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 80)}`);
    }
  }

  /** Handle one parsed JSON-RPC message or batch. Returns the response (or null for notifications). */
  async function handle(msg) {
    if (Array.isArray(msg)) {
      if (!msg.length) return err(null, RPC.INVALID_REQUEST, "Invalid request: empty batch");
      const out = (await Promise.all(msg.map((m) => handle(m)))).filter(Boolean);
      return out.length ? out : null;
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return err(msg?.id ?? null, RPC.INVALID_REQUEST, "Invalid request: expected a JSON-RPC 2.0 object");
    if (!("method" in msg)) return null; // a response to us; we never send requests
    try { return await dispatch(msg); }
    catch (e) { log(`internal error: ${e.stack || e}`); return msg.id == null ? null : err(msg.id, RPC.INTERNAL, e.message); }
  }

  /** Handle one raw line of text. */
  async function handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return err(null, RPC.PARSE, "Parse error: invalid JSON"); }
    return handle(msg);
  }

  return { handle, handleLine, ctx, get initialized() { return initialized; } };
}
