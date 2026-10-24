#!/usr/bin/env node
// BotGathering MCP server, stdio transport (newline-delimited JSON-RPC on stdin/stdout).
// Logs go to stderr only. Configuration via environment variables:
//   BOTGATHERING_API_KEY     optional bot key (bb_...) for whoami/download_recipe/report_result
//   BOTGATHERING_BASE_URL    REST API origin (default https://botgathering.com)
//   BOTGATHERING_TIMEOUT_MS  HTTP timeout (default 20000)
//   BOTGATHERING_MIRROR_DIR  directory with the offline recipe mirror (default ../recipes)
import { createInterface } from "node:readline";
import { createServer, SERVER_INFO } from "./server.js";

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) { process.stderr.write(`botgathering-mcp needs Node.js 18 or newer (found ${process.version})\n`); process.exit(1); }

if (process.argv.includes("--version")) { process.stdout.write(SERVER_INFO.version + "\n"); process.exit(0); }

const log = (s) => process.stderr.write(`[botgathering-mcp] ${s}\n`);
const server = createServer({ log });
let pending = 0, closing = false;

const write = (obj) => { if (obj) process.stdout.write(JSON.stringify(obj) + "\n"); };
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  pending++;
  try { write(await server.handleLine(line)); }
  catch (e) { log(`unhandled: ${e.stack || e}`); }
  finally { pending--; if (closing && !pending) process.exit(0); }
});
rl.on("close", () => { closing = true; if (!pending) process.exit(0); });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
log(`v${SERVER_INFO.version} ready on stdio (API ${server.ctx.baseUrl}${server.ctx.apiKey ? ", key set" : ""})`);
