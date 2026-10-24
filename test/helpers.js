// Test helper: runs the real stdio server (src/index.js) as a child process and talks JSON-RPC to it.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

export function startServer(env = {}) {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map(); let nextId = 1; let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    const key = Array.isArray(msg) ? "batch" : msg.id;
    const w = waiting.get(key); if (w) { waiting.delete(key); w(msg); }
  });
  const send = (obj, key) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${key}; stderr: ${stderr}`)), 30000);
    waiting.set(key, (m) => { clearTimeout(t); res(m); });
    child.stdin.write((typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n");
  });
  return {
    child, get stderr() { return stderr; },
    request: (method, params) => { const id = nextId++; return send({ jsonrpc: "2.0", id, method, params }, id); },
    raw: (text, key) => send(text, key),
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    call: async (name, args) => (await (async () => { const id = nextId++; return send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, id); })()).result,
    close: () => new Promise((res) => { child.once("exit", res); child.stdin.end(); }),
  };
}

export const text = (result) => result.content.map((c) => c.text).join("\n");
