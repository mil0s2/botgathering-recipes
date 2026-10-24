// Offline tests: protocol, tools/list, validation, every tool against a local mock of the REST API,
// and the offline mirror fallback. No network access needed. Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, text } from "./helpers.js";
import { startMockApi, KEY } from "./mock-api.js";

let api, srv;
before(async () => { api = await startMockApi(); srv = startServer({ BOTGATHERING_BASE_URL: api.url }); });
after(async () => { await srv.close(); await api.close(); });

const EXPECTED = ["ask_how_to", "search_recipes", "get_recipe", "get_recipe_details", "list_categories", "register_bot", "whoami", "download_recipe", "report_result", "quick_report"];

test("initialize negotiates the protocol and advertises tools + resources", async () => {
  const r = await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "offline-test", version: "1" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.equal(r.result.serverInfo.name, "botgathering");
  assert.ok(r.result.capabilities.tools && r.result.capabilities.resources);
  assert.match(r.result.instructions, /ask_how_to/);
  srv.notify("notifications/initialized");
  const old = await srv.request("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(old.result.protocolVersion, "2024-11-05");
  const unknown = await srv.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.result.protocolVersion, "2025-06-18");
});

test("tools/list returns the 10 tools with schemas and annotations", async () => {
  const { result } = await srv.request("tools/list", {});
  assert.deepEqual(result.tools.map((t) => t.name), EXPECTED);
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description.length > 150, t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    assert.ok(!JSON.stringify(t).includes("x-format-hint"), t.name);
  }
});

test("ping, unknown method, parse error, batch", async () => {
  assert.deepEqual((await srv.request("ping")).result, {});
  assert.equal((await srv.request("does/not/exist")).error.code, -32601);
  const pe = await srv.raw("{not json", null);
  assert.equal(pe.error.code, -32700);
  const batch = await srv.raw(JSON.stringify([{ jsonrpc: "2.0", id: "b1", method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }, { jsonrpc: "2.0", id: "b2", method: "tools/list" }]), "batch");
  assert.equal(batch.length, 2);
});

test("validation errors are reported as tool errors, without calling the API", async () => {
  const before_ = api.hits.length;
  const cases = [
    ["ask_how_to", {}, /required.*task/i],
    ["ask_how_to", { task: "x" }, /task/],
    ["ask_how_to", { task: "inbox", max_results: 9 }, /max_results/],
    ["search_recipes", { sort: "random" }, /sort/],
    ["search_recipes", { limit: 0 }, /limit/],
    ["search_recipes", { bogus: 1 }, /bogus/],
    ["get_recipe", {}, /slug/],
    ["register_bot", { handle: "A!", signature: "ok sig" }, /handle/],
    ["register_bot", { handle: "tester-x", signature: "x" }, /signature/],
    ["whoami", { api_key: "nope" }, /api_key/],
    ["report_result", { token: "tok_1234567890", notes: "hi" }, /notes/],
    ["report_result", { token: "tok_1234567890", notes: "worked well", rating: 7 }, /rating/],
    ["report_result", { token: "tok_1234567890", notes: "worked well", metric_value: -1 }, /metric_value/],
    ["quick_report", { slug: "daily-inbox-triage", outcome: "meh" }, /outcome/],
  ];
  for (const [name, args, re] of cases) {
    const r = await srv.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(text(r), re, `${name}: ${text(r)}`);
  }
  assert.equal(api.hits.length, before_, "validation must fail before any HTTP request");
  const unknownTool = await srv.request("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
});

test("local safety checks: keys, personal data and secrets never leave the server", async () => {
  const n = api.hits.length;
  let r = await srv.call("whoami", {});
  assert.equal(r.isError, true); assert.match(text(r), /register_bot/);
  r = await srv.call("report_result", { token: "tok_1234567890", notes: "worked well", outcome: "success" });
  assert.match(text(r), /BOTGATHERING_API_KEY/);
  r = await srv.call("register_bot", { handle: "tester-pii", signature: "mail me at someone@example.org" });
  assert.match(text(r), /Nothing was sent/);
  r = await srv.call("report_result", { token: "tok_1234567890", notes: "key bb_abcdefghijklmnop123 leaked", outcome: "failure", api_key: KEY });
  assert.match(text(r), /Nothing was sent/);
  r = await srv.call("register_bot", { handle: "botgathering-x", signature: "official" });
  assert.match(text(r), /reserved/);
  assert.equal(api.hits.filter((h) => h.method === "POST").length, 0);
  assert.ok(api.hits.length >= n);
});

test("ask_how_to ranks the catalogue locally and reports no_good_match", async () => {
  let r = await srv.call("ask_how_to", { task: "sort my email inbox every morning" });
  assert.ok(!r.isError, text(r));
  assert.equal(r.structuredContent.answers[0].slug, "daily-inbox-triage");
  assert.match(text(r), /get_recipe\(slug='daily-inbox-triage'\)/);
  r = await srv.call("ask_how_to", { task: "qwxz plorb fnord" });
  assert.equal(r.structuredContent.no_good_match, true);
});

test("search_recipes, list_categories, get_recipe, get_recipe_details", async () => {
  let r = await srv.call("search_recipes", { category: "coding", limit: "5" });
  assert.equal(r.structuredContent.recipes[0].slug, "bug-fix-pull-request-workflow");
  assert.match(text(r), /score 60\/100/);
  r = await srv.call("search_recipes", { category: "nonexistent" });
  assert.equal(r.isError, true); assert.match(text(r), /Valid slugs/);
  r = await srv.call("list_categories", {});
  assert.equal(r.structuredContent.categories.length, 3);
  r = await srv.call("get_recipe", { slug: "https://botgathering.com/recipe/daily-inbox-triage.md" });
  assert.match(text(r), /# Daily inbox triage/); assert.match(text(r), /quick_report/);
  r = await srv.call("get_recipe", { slug: "Daily inbox triage" });
  assert.equal(r.structuredContent.slug, "daily-inbox-triage");
  r = await srv.call("get_recipe", { slug: "daily-inbx-triage" });
  assert.equal(r.isError, true); assert.match(text(r), /Did you mean: 'daily-inbox-triage'/);
  r = await srv.call("get_recipe_details", { slug: "daily-inbox-triage", max_reports: 5 });
  assert.match(text(r), /Latest reports/); assert.match(text(r), /tester-a/);
  assert.equal(r.structuredContent.versions[0].body, undefined);
});

test("account and write tools (mock API only)", async () => {
  let r = await srv.call("whoami", { api_key: KEY });
  assert.match(text(r), /@tester-bot/); assert.match(text(r), /t\*\*\*@example.org/); assert.ok(!text(r).includes("tester@example.org"));
  r = await srv.call("download_recipe", { slug: "daily-inbox-triage" });
  assert.equal(r.structuredContent.downloaded, false); assert.match(text(r), /CONTRACT v1.1/);
  r = await srv.call("download_recipe", { slug: "daily-inbox-triage", accept_contract: true, api_key: KEY });
  assert.equal(r.structuredContent.report_token, "tok_1234567890");
  const dl = api.hits.filter((h) => h.path.endsWith("/download")).at(-1);
  assert.deepEqual(dl.body, { accept_contract: true, contract_version: "1.1" });
  r = await srv.call("report_result", { report_token: "tok_1234567890", outcome: "worked", notes: "it worked on the first try", api_key: KEY });
  assert.ok(!r.isError, text(r)); assert.match(text(r), /Report filed/);
  assert.equal(api.hits.find((h) => h.path === "/api/report").body.client, "offline-test 1");
  r = await srv.call("report_result", { token: "used_token_123", outcome: "success", notes: "again again", api_key: KEY });
  assert.match(text(r), /already used/);
  r = await srv.call("quick_report", { recipe: "daily-inbox-triage", result: "failed", notes: "step 3 broke" });
  assert.ok(!r.isError, text(r));
  assert.equal(api.hits.find((h) => h.path.endsWith("/quick-report")).body.outcome, "failure");
  assert.equal(r.structuredContent.api_key, undefined, "keys are not repeated in structured output");
  r = await srv.call("register_bot", { handle: "tester-new", signature: "Test agent for the MCP server" });
  assert.match(text(r), /shown only once/);
  r = await srv.call("register_bot", { handle: "tester-taken", signature: "Test agent" });
  assert.match(text(r), /already taken/);
});

test("resources: mirror recipes are listed and readable", async () => {
  const { result } = await srv.request("resources/list", {});
  assert.ok(result.resources.length >= 40);
  const uri = result.resources[0].uri;
  const rd = await srv.request("resources/read", { uri });
  assert.ok(rd.result.contents[0].text.length > 100);
  assert.equal((await srv.request("resources/read", { uri: "botgathering://recipe/nope-nope" })).error.code, -32002);
});

test("the server never calls the hosted /mcp endpoint", () => {
  assert.ok(api.hits.length > 10);
  assert.equal(api.hits.filter((h) => h.path.startsWith("/mcp")).length, 0);
});

test("offline fallback: API unreachable -> bundled markdown mirror", async () => {
  const off = startServer({ BOTGATHERING_BASE_URL: "http://127.0.0.1:9", BOTGATHERING_TIMEOUT_MS: "2000" });
  try {
    let r = await off.call("get_recipe", { slug: "beginner-running-plan-couch-to-5k" });
    assert.ok(!r.isError, text(r)); assert.match(text(r), /bundled with this server/); assert.equal(r.structuredContent.source, "mirror");
    r = await off.call("ask_how_to", { task: "start running from zero, couch to 5k" });
    assert.equal(r.structuredContent.source, "mirror");
    assert.equal(r.structuredContent.answers[0].slug, "beginner-running-plan-couch-to-5k");
    r = await off.call("search_recipes", { query: "running" });
    assert.equal(r.structuredContent.source, "mirror");
    r = await off.call("list_categories", {});
    assert.equal(r.isError, true); assert.match(text(r), /network/);
  } finally { await off.close(); }
});
