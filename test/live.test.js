// Live tests against the public botgathering.com REST API (read-only).
// Run: npm run test:live   (needs internet). Creates no records: write tools are only
// exercised up to local validation or a keyless contract preview (which records nothing).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, text } from "./helpers.js";

let srv;
const env = { BOTGATHERING_BASE_URL: process.env.BOTGATHERING_BASE_URL || "https://botgathering.com" }; // no API key on purpose
before(async () => { srv = startServer(env); await srv.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "botgathering-mcp-live-test", version: "1" } }); });
after(() => srv.close());

let someSlug;
test("list_categories (GET /api/categories)", async () => {
  const r = await srv.call("list_categories", {});
  assert.ok(!r.isError, text(r));
  assert.ok(r.structuredContent.categories.length >= 10);
  assert.ok(r.structuredContent.total_recipes > 40);
});

test("search_recipes browse (GET /api/recipes, no query)", async () => {
  const r = await srv.call("search_recipes", { category: "coding", sort: "score", limit: 5 });
  assert.ok(!r.isError, text(r));
  assert.ok(r.structuredContent.recipes.length > 0);
  assert.ok(r.structuredContent.recipes.every((x) => x.category === "coding"));
  someSlug = r.structuredContent.recipes[0].slug;
});

test("search_recipes keyword query", async () => {
  const r = await srv.call("search_recipes", { query: "mcp server", limit: 3 });
  assert.ok(!r.isError, text(r));
  assert.ok(r.structuredContent.total > 0);
});

test("ask_how_to (local ranking over the live catalogue)", async () => {
  const r = await srv.call("ask_how_to", { task: "my MCP server's tools do not show up in the client" });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.source, "api");
  assert.match(r.structuredContent.answers[0].slug, /mcp/);
});

test("get_recipe (GET /recipe/{slug}.md) incl. URL input and did-you-mean", async () => {
  let r = await srv.call("get_recipe", { slug: `https://botgathering.com/recipe/${someSlug}` });
  assert.ok(!r.isError, text(r)); assert.match(text(r), /^# /);
  r = await srv.call("get_recipe", { slug: someSlug.replace(/-/g, " ").slice(0, -1) + "x" });
  assert.ok(r.isError || r.structuredContent.slug === someSlug, text(r));
});

test("get_recipe_details (GET /api/recipes/{slug})", async () => {
  const r = await srv.call("get_recipe_details", { slug: someSlug, max_reports: 3 });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.slug, someSlug);
  assert.ok(Array.isArray(r.structuredContent.versions));
});

test("whoami without a key explains how to get one (no request)", async () => {
  const r = await srv.call("whoami", {});
  assert.equal(r.isError, true); assert.match(text(r), /register_bot/);
});

test("download_recipe without key: contract preview only (POST /api/recipes/{slug}/download -> 401, nothing recorded)", async () => {
  const r = await srv.call("download_recipe", { slug: someSlug });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.downloaded, false);
  assert.ok(r.structuredContent.contract.version);
});

test("write tools stop at local validation (no records created)", async () => {
  for (const [n, a] of [["register_bot", { handle: "tester-x", signature: "call +48 600 700 800 900" }], ["report_result", { token: "tok_live_test_00", notes: "x" }], ["quick_report", { slug: someSlug, outcome: "maybe" }]]) {
    const r = await srv.call(n, a);
    assert.equal(r.isError, true, `${n}: ${text(r)}`);
  }
});
