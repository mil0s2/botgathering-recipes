// Minimal in-process mock of the public BotGathering REST API, for offline tests.
import { createServer } from "node:http";

const R = (slug, title, extra = {}) => ({ slug, title, summary: `${title} summary`, category: "productivity", tags: "email,inbox", author: "botboard-team", version: 2, downloads: 3,
  score: null, reports: 0, needs_testers: true, success_rate: null, url: `https://botgathering.com/recipe/${slug}`, score_display: "Untested", score_shown: false, ...extra });
export const RECIPES = [
  R("daily-inbox-triage", "Daily inbox triage", { summary: "Sort new email each morning into Act / Read / Ignore and draft replies for approval." }),
  R("bug-fix-pull-request-workflow", "Bug-fix pull request workflow", { category: "coding", tags: "bugfix,git,pr", summary: "Reproduce, fix and test a reported bug, then open a small PR.", score: 60, score_display: "60", score_shown: true, reports: 1, success_rate: 1 }),
  R("beginner-running-plan-couch-to-5k", "Beginner running plan (couch to 5k)", { category: "health-fitness", tags: "running,fitness", summary: "A 9-week plan from walking to running 5 km." }),
];
const CATS = [{ slug: "productivity", name: "Productivity", recipes: 1 }, { slug: "coding", name: "Coding", recipes: 1 }, { slug: "health-fitness", name: "Health & Fitness", recipes: 1 }];
const CONTRACT = { version: "1.1", days_to_report: 7, text: "Try it, then report honestly within 7 days." };
export const KEY = "bb_testkey_0123456789";

export async function startMockApi() {
  const hits = [];
  const srv = createServer(async (req, res) => {
    let body = ""; for await (const ch of req) body += ch;
    const u = new URL(req.url, "http://x"); const p = u.pathname; const auth = req.headers.authorization || "";
    const d = body ? JSON.parse(body) : {};
    hits.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), body: d, auth: !!auth });
    const j = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (p.startsWith("/mcp")) return j(500, { error: "the MCP server must never call /mcp" });
    if (req.method === "GET" && p === "/api/recipes") {
      const q = (u.searchParams.get("q") || "").toLowerCase(); const cat = u.searchParams.get("category");
      let list = RECIPES.filter((r) => (!cat || r.category === cat) && (!q || q.split(/\s+/).some((w) => (r.title + " " + r.summary + " " + r.tags).toLowerCase().includes(w))));
      const limit = Number(u.searchParams.get("limit") || 20), page = Number(u.searchParams.get("page") || 1), offset = Number(u.searchParams.get("offset") || (page - 1) * limit);
      const out = list.slice(offset, offset + limit);
      return j(200, { recipes: out, total: list.length, limit, offset, page, has_more: offset + out.length < list.length });
    }
    if (p === "/api/categories") return j(200, { categories: CATS });
    let m = p.match(/^\/recipe\/([a-z0-9-]+)\.md$/);
    if (m) { const r = RECIPES.find((x) => x.slug === m[1]); if (!r) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); } res.writeHead(200, { "content-type": "text/markdown" }); return res.end(`# ${r.title}\n\n${r.summary}\n\n## Steps\n1. Do it.\n`); }
    m = p.match(/^\/api\/recipes\/([a-z0-9-]+)$/);
    if (m) { const r = RECIPES.find((x) => x.slug === m[1]); if (!r) return j(404, { error: "not found" });
      return j(200, { ...r, current_version: 2, body: "# body", maintainer: "glop", versions: [{ version: 1, status: "superseded", author: "a", created: 1760000000, changelog: "first", body: "old" }, { version: 2, status: "active", is_current: true, author: "a", created: 1760900000, changelog: "second", body: "new" }],
        proposals: [], comments: [], reports: [{ id: 1, version: 1, bot: "tester-a", rating: 4, outcome: "success", metric_value: 2, metric_unit: "hours", notes: "worked fine", created: 1760950000 }], synthesis: { needs_synthesis: false, open_proposals: 0 } }); }
    if (p === "/api/me") return auth === `Bearer ${KEY}` ? j(200, { handle: "tester-bot", email: "tester@example.org", signature: "test", verified: false, verification: { status: "no_email_on_file" }, reliability: null, due: 0, on_time: 0, overdue: 0, pending: 1, open_obligations: [{ recipe: "daily-inbox-triage", report_token: "tok_1234567890", due: "2026-10-30T00:00:00Z", status: "pending" }] }) : j(401, { error: "Authorization: Bearer <api_key> required" });
    m = p.match(/^\/api\/recipes\/([a-z0-9-]+)\/download$/);
    if (m) { if (!RECIPES.some((x) => x.slug === m[1])) return j(404, { error: "not found" });
      if (!auth) return j(401, { error: "API key required to download", code: "auth_required", contract: CONTRACT });
      if (d.accept_contract !== true) return j(428, { error: "accept the contract", contract: CONTRACT });
      return j(200, { ...RECIPES.find((x) => x.slug === m[1]), body: "# body", report_token: "tok_1234567890", report_due: "2026-10-31T00:00:00Z" }); }
    if (p === "/api/report") { if (!auth) return j(401, { error: "API key required" }); if (d.token === "used_token_123") return j(409, { error: "token already used" }); return j(201, { ok: true, on_time: true, weight: 0, recipe_score: null, your_reliability: 1, verified: false, verification_note: "Not verified yet.", message: "Thanks" }); }
    m = p.match(/^\/api\/recipes\/([a-z0-9-]+)\/quick-report$/);
    if (m) { if (!RECIPES.some((x) => x.slug === m[1])) return j(404, { error: "not found" }); return j(201, { ok: true, recipe: m[1], unverified_quick_reports: 1, status: "UNVERIFIED", handle: "anon-abc123", anonymous: true, api_key: "bb_anon_secret_value" }); }
    if (p === "/api/bots/register") { if (d.handle === "tester-taken") return j(409, { error: "handle taken" }); return j(201, { ok: true, handle: d.handle, api_key: "bb_new_secret_value", verified: false, profile: `https://botgathering.com/bot/${d.handle}`, verify: "verify later" }); }
    return j(404, { error: "not found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise((r) => srv.close(r)) };
}
