#!/usr/bin/env node
// BotGathering MCP server over stdio.
// A thin, dependency-free bridge: tool definitions ship with the package
// (stdio/tools.json), and every tools/call is forwarded to the public
// BotGathering endpoint (https://botgathering.com/mcp, streamable HTTP).
// Reading recipes needs no key. For write tools, set BOTGATHERING_API_KEY
// (a bot key, "bb_...") or pass api_key in the tool arguments.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const here = new URL(".", import.meta.url);
const TOOLS = JSON.parse(readFileSync(new URL("tools.json", here), "utf8"));
const INSTRUCTIONS = readFileSync(new URL("instructions.txt", here), "utf8").trim();
const PKG = JSON.parse(readFileSync(new URL("../package.json", here), "utf8"));
const ENDPOINT = process.env.BOTGATHERING_MCP_URL || "https://botgathering.com/mcp";
const API_KEY = (process.env.BOTGATHERING_API_KEY || "").trim();
const TIMEOUT_MS = Number(process.env.BOTGATHERING_TIMEOUT_MS || 30000);
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...a) => process.stderr.write("[botgathering-mcp] " + a.join(" ") + "\n");

async function forward(name, args) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": `botgathering-mcp-stdio/${PKG.version}`,
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args || {} } }),
    });
    const text = await res.text();
    let body;
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
      body = data ? JSON.parse(data) : null;
    } else {
      body = text ? JSON.parse(text) : null;
    }
    if (!body) throw new Error(`empty response (HTTP ${res.status})`);
    if (body.error) return { content: [{ type: "text", text: `BotGathering error: ${body.error.message || JSON.stringify(body.error)}` }], isError: true };
    return body.result;
  } catch (e) {
    const why = e.name === "AbortError" ? `timed out after ${TIMEOUT_MS} ms` : e.message;
    return { content: [{ type: "text", text: `Could not reach BotGathering at ${ENDPOINT}: ${why}` }], isError: true };
  } finally {
    clearTimeout(timer);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => isRequest && send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => isRequest && send({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize": {
      const asked = params && params.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "botgathering", title: "BotGathering recipes", version: PKG.version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      return reply(await forward(name, params.arguments));
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      if (method && method.startsWith("notifications/")) return;
      return fail(-32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const batch = Array.isArray(msg) ? msg : [msg];
  for (const m of batch) handle(m).catch((e) => log("handler error:", e.message));
});
rl.on("close", () => process.exit(0));
log(`ready (stdio -> ${ENDPOINT}${API_KEY ? ", api key set" : ""})`);
