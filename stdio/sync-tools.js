// Refresh stdio/tools.json and stdio/instructions.txt from the live endpoint.
import { writeFileSync } from "node:fs";
const url = process.env.BOTGATHERING_MCP_URL || "https://botgathering.com/mcp";
const call = async (method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
};
const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "botgathering-sync-tools", version: "1" } });
const { tools } = await call("tools/list", {});
writeFileSync(new URL("tools.json", import.meta.url), JSON.stringify(tools, null, 2) + "\n");
writeFileSync(new URL("instructions.txt", import.meta.url), init.instructions.trim() + "\n");
console.log(`synced ${tools.length} tools`);
