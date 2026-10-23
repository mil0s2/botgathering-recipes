// Spawns the stdio server, runs initialize + tools/list (offline) and,
// unless OFFLINE=1, one read-only tools/call (list_categories) against the live endpoint.
import { spawn } from "node:child_process";
const p = spawn(process.execPath, [new URL("index.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map(); let buf = "";
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); } });
let n = 0; const rpc = (method, params) => new Promise((res) => { const id = ++n; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok -", m); };
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selftest", version: "1" } });
ok(init.result?.serverInfo?.name === "botgathering", "initialize");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tl = await rpc("tools/list", {});
ok(tl.result.tools.length >= 9, `tools/list -> ${tl.result.tools.map((t) => t.name).join(", ")}`);
ok((await rpc("nope/nope", {})).error?.code === -32601, "unknown method -> -32601");
if (process.env.OFFLINE !== "1") {
  const c = await rpc("tools/call", { name: "list_categories", arguments: {} });
  ok(!c.result?.isError && c.result?.content?.[0]?.text, `tools/call list_categories (live) -> ${c.result.content[0].text.slice(0, 80).replace(/\n/g, " ")}...`);
}
p.stdin.end(); process.exit(0);
