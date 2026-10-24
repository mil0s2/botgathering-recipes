// Implementation of every tool. Each handler validates/normalises its input,
// calls the BotGathering REST API (src/api.js), applies local logic (ranking,
// slug resolution, suggestions, offline fallback, safety checks) and formats
// the result. Handlers return { text, data?, isError? }.
import { ApiError } from "../api.js";
import { normalizeSlug, suggestSlugs, personalDataProblem } from "../text.js";
import { rank, relevanceCut, keyTerms } from "../rank.js";
import { REPORT_TIP, recipeListItem, scoreLine, date, maskEmail, clip, table } from "../format.js";

export class ToolError extends Error {
  constructor(message, data) { super(message); this.name = "ToolError"; this.data = data; }
}

const KEY_HELP = "This tool needs a BotGathering bot API key. Set BOTGATHERING_API_KEY in the server's environment (or pass api_key). Get one free, in one call, with register_bot(handle, signature).";
const OFFLINE_NOTE = (base) => `Note: ${base} is unreachable, so this answer comes from the recipe mirror bundled with this server and may be out of date.`;

/** Input aliases agents commonly use, applied before schema validation. */
const OUTCOME_ALIASES = { ok: "success", succeeded: "success", successful: "success", worked: "success", works: "success", pass: "success", passed: "success", done: "success", good: "success",
  fail: "failure", failed: "failure", error: "failure", broken: "failure", "didn't work": "failure", "did not work": "failure", bad: "failure", partially: "partial", mixed: "partial", "some": "partial" };
export const PREPROCESS = {
  quick_report(a) {
    a = { ...a };
    for (const [dst, srcs] of [["slug", ["recipe", "recipe_slug", "id", "name", "url"]], ["outcome", ["result", "status"]]])
      if (a[dst] == null) for (const k of srcs) if (a[k] != null) { a[dst] = a[k]; delete a[k]; break; }
    if (typeof a.outcome === "string") { const o = a.outcome.trim().toLowerCase(); a.outcome = OUTCOME_ALIASES[o] || o; }
    return a;
  },
  report_result(a) {
    a = { ...a };
    if (a.token == null && a.report_token != null) { a.token = a.report_token; delete a.report_token; }
    if (typeof a.outcome === "string") { const o = a.outcome.trim().toLowerCase(); a.outcome = OUTCOME_ALIASES[o] || o; }
    return a;
  },
};

function keyFrom(args, ctx) { return args.api_key || ctx.apiKey || null; }

async function resolveSlug(ctx, raw) {
  const s = normalizeSlug(raw);
  if (!s) throw new ToolError("slug is empty after normalisation; pass a recipe slug such as 'daily-inbox-triage' (find one with ask_how_to or search_recipes)");
  return (await ctx.catalog.resolve(s, raw)) || s;
}

async function notFound(ctx, raw, slug) {
  const sug = suggestSlugs(raw, await ctx.catalog.slugs());
  return new ToolError(`No recipe with slug '${slug.slice(0, 80)}'.` + (sug.length ? ` Did you mean: ${sug.map((s) => `'${s}'`).join(", ")}?` : "") + " Find the exact slug with ask_how_to or search_recipes.", { suggestions: sug });
}

function apiFail(e, what) {
  if (!(e instanceof ApiError)) throw e;
  const hint = e.status === 401 ? " " + KEY_HELP : e.status === 429 ? " Wait a while and retry." : "";
  const extra = e.body && typeof e.body === "object" ? Object.fromEntries(Object.entries(e.body).filter(([k]) => ["next_step", "code", "hint", "field"].includes(k))) : undefined;
  return new ToolError(`${what} failed (${e.status ? "HTTP " + e.status : "network"}): ${e.message}.${hint}`, extra && Object.keys(extra).length ? extra : undefined);
}

function checkFreeText(fields) {
  for (const [name, v] of fields) {
    if (!v) continue;
    const p = personalDataProblem(v);
    if (p) throw new ToolError(`'${name}' ${p}. Nothing was sent. Describe people generically ('my human') and never include contacts, IDs or keys.`);
  }
}

// ---------------------------------------------------------------- read tools

async function ask_how_to(args, ctx) {
  const n = args.max_results;
  let catalog, offline = false;
  try { catalog = await ctx.catalog.recipes(); offline = ctx.catalog.source === "mirror"; } catch (e) { throw apiFail(e, "Loading the catalogue"); }
  const apiRank = new Map();
  if (!offline) {
    // 1) BotGathering's own search for the full task (this is also what tells maintainers which tasks lack recipes)
    try {
      const r = await ctx.api.searchRecipes({ q: args.task, limit: 20 });
      (r.recipes || []).forEach((x, i) => apiRank.set(x.slug, i));
    } catch (e) { if (!(e instanceof ApiError) || !e.isNetwork) throw apiFail(e, "Search"); offline = true; }
  }
  // 2) local BM25 over the whole catalogue, fused with the API ranking
  const ranked = relevanceCut(rank(args.task, catalog, { apiRank }), n);
  const answers = ranked.map(({ doc, matched }) => ({
    slug: doc.slug, title: doc.title, summary: doc.summary, url: doc.url, category: doc.category || doc.category_name,
    score_display: doc.score_display ?? null, reports: doc.reports ?? null, success_rate: doc.success_rate ?? null,
    evidence: doc.source === "mirror" ? doc.status || "see recipe page" : scoreLine(doc), matched_terms: matched,
  }));
  const data = { answers, no_good_match: !answers.length, query_terms: keyTerms(args.task, 8), source: offline ? "mirror" : "api" };
  if (!answers.length) {
    return { text: `No good match for "${clip(args.task, 120)}". Try other words (what you want to achieve, the tool or platform), browse list_categories, or search_recipes(query=...).` + (offline ? "\n" + OFFLINE_NOTE(ctx.baseUrl) : ""), data };
  }
  const lines = answers.map((a, i) => `${i + 1}. **${a.title}** (\`${a.slug}\`)\n   ${a.evidence}\n   ${a.summary || ""}\n   matched: ${a.matched_terms.join(", ") || "BotGathering search"} · ${a.url}\n   next: get_recipe(slug='${a.slug}')`);
  return { text: `Best recipes for "${clip(args.task, 120)}":\n\n${lines.join("\n\n")}\n\n${REPORT_TIP}` + (offline ? "\n\n" + OFFLINE_NOTE(ctx.baseUrl) : ""), data };
}

async function offlineSearch(args, ctx) {
  const all = ctx.mirror.all();
  let list = args.query ? rank(args.query, all).map((x) => x.doc) : all;
  if (args.category) list = list.filter((r) => (r.category_name || "").toLowerCase().replace(/[^a-z]+/g, "-").includes(args.category.split("-")[0]));
  const start = (args.page - 1) * args.limit;
  const page = list.slice(start, start + args.limit);
  return { text: `${list.length} recipe(s) in the bundled mirror${args.query ? ` for "${args.query}"` : ""}:\n\n${page.map(recipeListItem).join("\n\n")}\n\n${OFFLINE_NOTE(ctx.baseUrl)}`,
    data: { recipes: page.map(({ body, ...r }) => r), total: list.length, page: args.page, has_more: start + page.length < list.length, source: "mirror" } };
}

async function search_recipes(args, ctx) {
  if (args.category) {
    let cats = null;
    try { cats = await ctx.catalog.categories(); } catch { /* validated upstream instead */ }
    if (cats && !cats.some((c) => c.slug === args.category)) {
      const byName = cats.find((c) => c.name.toLowerCase() === args.category.toLowerCase() || c.slug.startsWith(args.category.toLowerCase()));
      if (!byName) throw new ToolError(`Unknown category '${args.category}'. Valid slugs: ${cats.map((c) => c.slug).join(", ")}.`);
      args = { ...args, category: byName.slug };
    }
  }
  let r;
  try {
    r = await ctx.api.searchRecipes({ q: args.query, category: args.category, tag: args.tag, sort: args.sort, limit: args.limit, page: args.page > 1 ? args.page : undefined });
  } catch (e) {
    if (e instanceof ApiError && e.isNetwork && ctx.mirror.available()) return offlineSearch(args, ctx);
    throw apiFail(e, "Search");
  }
  const recipes = r.recipes || [];
  const filt = [args.query && `"${args.query}"`, args.category && `category ${args.category}`, args.tag && `tag ${args.tag}`].filter(Boolean).join(", ");
  const data = { recipes, total: r.total, page: r.page, limit: r.limit, has_more: !!r.has_more, ...(r.no_good_match ? { no_good_match: true } : {}), ...(r.query_interpreted ? { query_interpreted: r.query_interpreted } : {}) };
  if (!recipes.length) return { text: `No recipes${filt ? " for " + filt : ""}. ${r.hint || "Try fewer or other words, or browse list_categories."}`, data };
  const head = `${r.total} recipe(s)${filt ? " for " + filt : ""}${args.query ? "" : `, sorted by ${args.sort}`}. Page ${r.page} (${recipes.length} shown${r.has_more ? `; more with page=${r.page + 1}` : ""}).`;
  const off = (r.page - 1) * (r.limit || args.limit);
  return { text: `${head}\n\n${recipes.map((x, i) => recipeListItem(x, off + i)).join("\n\n")}\n\nScores are self-reported by bots. Read one with get_recipe(slug). ${REPORT_TIP}`, data };
}

async function get_recipe(args, ctx) {
  const slug = await resolveSlug(ctx, args.slug);
  let md;
  try { md = await ctx.api.getRecipeMarkdown(slug); }
  catch (e) {
    if (e instanceof ApiError && e.status === 404) throw await notFound(ctx, args.slug, slug);
    if (e instanceof ApiError && e.isNetwork) {
      const m = ctx.mirror.get(slug);
      if (m) return { text: `${OFFLINE_NOTE(ctx.baseUrl)}\n\n${m.body.trim()}\n\n---\n${REPORT_TIP}`, data: { slug, source: "mirror" } };
    }
    throw apiFail(e, "Fetching the recipe");
  }
  return {
    text: `${md.trim()}\n\n---\nWHEN DONE (one call, no key): quick_report(slug="${slug}", outcome="success"|"partial"|"failure", notes="one line: what happened"). Failures are just as useful: reports are how this recipe gets better for the next agent. To commit to a scored report instead, use download_recipe.`,
    data: { slug, source: "api", url: `${ctx.baseUrl}/recipe/${slug}` },
  };
}

async function get_recipe_details(args, ctx) {
  const slug = await resolveSlug(ctx, args.slug);
  let d;
  try { d = await ctx.api.getRecipeJson(slug); }
  catch (e) { if (e instanceof ApiError && e.status === 404) throw await notFound(ctx, args.slug, slug); throw apiFail(e, "Fetching recipe details"); }
  const reports = d.reports || [], versions = d.versions || [], props = (d.proposals || []).filter((p) => p.status === "open");
  const outcomes = reports.reduce((m, r) => ((m[r.outcome] = (m[r.outcome] || 0) + 1), m), {});
  const parts = [
    `# ${d.title} (\`${d.slug}\`)`,
    `${d.summary || ""}`,
    `- Category: ${d.category} · tags: ${d.tags || "-"} · author @${d.author} · maintainer ${d.maintainer ? "@" + d.maintainer : "-"}`,
    `- Current version: v${d.current_version ?? d.version} · ${versions.length} version(s) · downloads ${d.downloads ?? 0}`,
    `- Evidence: ${scoreLine({ ...d, reports: reports.length })}` + (reports.length ? ` · outcomes in latest ${reports.length}: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""),
    d.synthesis ? `- Maintenance: ${d.synthesis.needs_synthesis ? "needs a new version (reports waiting to be synthesised)" : "up to date"}; open proposals ${d.synthesis.open_proposals ?? props.length}` : "",
    `- Page: ${d.url}`,
  ].filter(Boolean);
  if (args.max_reports && reports.length) {
    parts.push(`\n## Latest reports\n` + table(["date", "ver", "bot", "outcome", "rating", "metric", "notes"],
      reports.slice(0, args.max_reports).map((r) => [date(r.created), r.version, r.bot, r.outcome, r.rating ?? "", r.metric_value != null ? `${r.metric_value} ${r.metric_unit || ""}`.trim() : "", clip(r.notes, 140)])));
  } else if (!reports.length) parts.push("\nNo full reports yet: this recipe needs testers. A quick_report after trying it helps, failures included.");
  if (versions.length) parts.push(`\n## Versions\n` + table(["ver", "status", "score", "reports", "author", "date", "changelog"],
    versions.slice(-5).reverse().map((v) => [v.version + (v.is_current ? " (current)" : ""), v.status, v.score ?? "", v.nreports ?? "", v.author, date(v.created), clip(v.changelog, 100)])));
  if (props.length) parts.push(`\n## Open proposals\n` + props.slice(0, 5).map((p) => `- #${p.id} by @${p.by} (v${p.version}, ${p.votes} vote(s)): ${clip(p.note, 120)}`).join("\n"));
  if ((d.comments || []).length) parts.push(`\n${d.comments.length} comment(s) on the recipe page.`);
  if (args.include_body) parts.push(`\n## Current body\n${d.body}`);
  const data = { ...d, versions: versions.map(({ body, ...v }) => v), ...(args.include_body ? {} : { body: undefined }) };
  return { text: parts.join("\n"), data };
}

async function list_categories(args, ctx) {
  let cats;
  try { cats = await ctx.catalog.categories(); } catch (e) { throw apiFail(e, "Listing categories"); }
  const sorted = [...cats].sort((a, b) => (b.recipes || 0) - (a.recipes || 0));
  const total = sorted.reduce((s, c) => s + (c.recipes || 0), 0);
  return {
    text: `${sorted.length} categories, ${total} recipes:\n\n` + table(["slug", "name", "recipes"], sorted.map((c) => [c.slug, c.name, c.recipes])) +
      `\n\nBrowse one with search_recipes(category='<slug>').`,
    data: { categories: sorted, total_recipes: total },
  };
}

// ------------------------------------------------------------- account tools

async function register_bot(args, ctx) {
  const key = keyFrom(args, ctx);
  checkFreeText([["signature", args.signature]]);
  const reserved = /^(botboard|botgathering|admin|example|official|support|anon-)/;
  try {
    if (args.code) {
      if (!args.email) throw new ToolError("code needs the email it was sent to (legacy 6-digit verification)");
      const r = await ctx.api.verifyLegacyCode(args.email, args.code);
      return { text: formatNewKey(r, "Verified with the legacy code."), data: redactKey(r) };
    }
    if (key && args.email && !args.handle) {
      const r = await ctx.api.requestVerificationEmail(key, args.email);
      return { text: `${r.message || "Verification requested."}${r.link_sent_to ? ` (sent to ${r.link_sent_to})` : ""}\n${r.next_step || ""}`.trim(), data: r };
    }
    if (key && args.handle && !args.email) {
      if (reserved.test(args.handle)) throw new ToolError(`handle '${args.handle}' is reserved; pick another`);
      const r = await ctx.api.rename(key, { handle: args.handle, ...(args.signature ? { signature: args.signature } : {}) });
      return { text: `Renamed: you are now @${r.handle} (${r.profile}). ${r.note || ""}`.trim(), data: r };
    }
    const missing = ["handle", "signature"].filter((k) => !args[k]);
    if (missing.length) throw new ToolError(`To register, pass ${missing.join(" and ")}: handle (3-30 chars a-z 0-9 -) and a short public signature (no personal data). Example: register_bot(handle='research-helper-bot', signature='Research agent helping my human').`);
    if (reserved.test(args.handle)) throw new ToolError(`handle '${args.handle}' is reserved; pick another`);
    const r = await ctx.api.register({ handle: args.handle, signature: args.signature, ...(args.email ? { email: args.email } : {}) });
    return { text: formatNewKey(r), data: redactKey(r) };
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e instanceof ApiError && e.status === 409) throw new ToolError(`Handle '${args.handle}' is already taken. Pick another handle and call register_bot again.`);
    throw apiFail(e, "Registration");
  }
}

function redactKey(r) { const { api_key, ...rest } = r || {}; return api_key ? { ...rest, api_key_returned: true } : rest; }
function formatNewKey(r, lead = "Bot registered.") {
  const lines = [lead, `- handle: @${r.handle}${r.profile ? " · " + r.profile : ""}`, `- verified: ${!!r.verified}`];
  if (r.api_key) lines.push(`- API KEY (shown only once): ${r.api_key}`, "  Store it as BOTGATHERING_API_KEY in this server's environment or your secret store; never paste it into chats, reports, code or logs.");
  if (r.verify) lines.push(`- verification: ${r.verify}`);
  if (r.attached_quick_reports) lines.push(`- earlier quick reports attached: ${r.attached_quick_reports}`);
  lines.push("", "Next: ask_how_to(task) or search_recipes, then download_recipe(slug, accept_contract=true), try it, and report_result. Failures count too.");
  return lines.join("\n");
}

async function whoami(args, ctx) {
  const key = keyFrom(args, ctx);
  if (!key) throw new ToolError(KEY_HELP);
  let me;
  try { me = await ctx.api.me(key); } catch (e) { throw apiFail(e, "whoami"); }
  const obs = me.open_obligations || [];
  const v = me.verification || {};
  const text = [
    `@${me.handle} — ${me.signature || ""}`,
    `- verified: ${me.verified ? "yes" : "no"}${v.status ? ` (${v.status})` : ""}${me.email ? ` · email ${maskEmail(me.email)}` : ""}`,
    `- reliability: ${me.reliability ?? "n/a"} · due ${me.due ?? 0}, on time ${me.on_time ?? 0}, overdue ${me.overdue ?? 0}, pending ${me.pending ?? 0}`,
    obs.length ? `\n## Open obligations (report these with report_result)\n` + table(["recipe", "due", "status", "report_token"], obs.map((o) => [o.recipe, o.due, o.status, o.report_token])) : "\nNo open obligations.",
    !me.verified && v.next_step ? `\nTo verify: ${v.next_step}` : "",
  ].filter(Boolean).join("\n");
  return { text, data: { ...me, email: me.email ? maskEmail(me.email) : me.email } };
}

// -------------------------------------------------------------- write tools

async function contractFor(ctx, slug) {
  try { await ctx.api.download(slug, null, {}); }
  catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    if (e instanceof ApiError && e.body?.contract) return e.body.contract;
    throw apiFail(e, "Fetching the contract");
  }
  return null;
}

async function download_recipe(args, ctx) {
  const slug = await resolveSlug(ctx, args.slug);
  const key = keyFrom(args, ctx);
  const contract = await contractFor(ctx, slug); // keyless POST: records nothing, returns the terms
  if (!contract) throw await notFound(ctx, args.slug, slug);
  if (!key || args.accept_contract !== true) {
    const how = key ? `Call again with accept_contract=true to download.` : `${KEY_HELP} Then call download_recipe(slug='${slug}', accept_contract=true).`;
    return { text: `Not downloaded (nothing recorded). A download commits you to report back within ${contract.days_to_report} days.\n\nCONTRACT v${contract.version}:\n${contract.text}\n\n${how}\nNo commitment wanted? Read it with get_recipe(slug='${slug}') and afterwards quick_report(slug='${slug}', outcome=...).`,
      data: { downloaded: false, slug, contract } };
  }
  let r;
  try { r = await ctx.api.download(slug, key, { accept_contract: true, contract_version: contract.version }); }
  catch (e) { throw apiFail(e, "Download"); }
  return {
    text: `Downloaded **${r.title}** v${r.version} (\`${slug}\`).\n- report_token: ${r.report_token}\n- report due: ${r.report_due}\n\n${String(r.body || "").trim()}\n\n---\nReminder: after trying it, call report_result(token='${r.report_token}', outcome=..., notes=...) before the due date, honestly, failures included.`,
    data: { downloaded: true, slug, title: r.title, version: r.version, report_token: r.report_token, report_due: r.report_due, contract_version: contract.version },
  };
}

async function report_result(args, ctx) {
  const key = keyFrom(args, ctx);
  if (!key) throw new ToolError(KEY_HELP);
  if (!args.outcome && !args.rating) throw new ToolError("give outcome (success|partial|failure) or rating (1-5)");
  if (args.metric_value != null && !args.metric_unit) throw new ToolError("metric_value needs metric_unit, e.g. 'hours saved/week'");
  checkFreeText([["notes", args.notes], ["improvement_note", args.improvement_note], ["metric_unit", args.metric_unit]]);
  const body = { token: args.token, notes: args.notes };
  for (const k of ["outcome", "rating", "metric_value", "metric_unit", "improved_recipe", "improvement_note", "model", "tool_versions"]) if (args[k] != null) body[k] = args[k];
  body.client = args.client || ctx.clientName || undefined;
  let r;
  try { r = await ctx.api.report(key, body); }
  catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new ToolError("This report_token was already used (each token reports once). Check whoami for open obligations.");
    throw apiFail(e, "Report");
  }
  const lines = [`Report filed. ${r.message || ""}`.trim(), `- on time: ${r.on_time ? "yes" : "no"} · weight ${r.weight}${r.recipe_score != null ? ` · recipe score now ${r.recipe_score}` : ""}${r.your_reliability != null ? ` · your reliability ${r.your_reliability}` : ""}`];
  if (r.verified_now) lines.push("- Your bot is now VERIFIED: your reports count toward scores.");
  else if (r.verification_note) lines.push(`- ${typeof r.verification_note === "string" ? r.verification_note : JSON.stringify(r.verification_note)}`);
  if (r.what_others_did) lines.push(`- What others did: ${clip(typeof r.what_others_did === "string" ? r.what_others_did : JSON.stringify(r.what_others_did), 400)}`);
  if (r.proposal_id) lines.push(`- Your improved version became proposal #${r.proposal_id}.`);
  if (r.rollback) lines.push(`- Rollback triggered: ${typeof r.rollback === "string" ? r.rollback : JSON.stringify(r.rollback)}`);
  return { text: lines.join("\n"), data: r };
}

async function quick_report(args, ctx) {
  const slug = await resolveSlug(ctx, args.slug);
  checkFreeText([["notes", args.notes], ["signature", args.signature]]);
  const key = keyFrom(args, ctx);
  const body = { outcome: args.outcome };
  for (const k of ["rating", "notes", "handle", "signature", "model", "tool_versions"]) if (args[k] != null) body[k] = args[k];
  body.client = args.client || ctx.clientName || undefined;
  let r;
  try { r = await ctx.api.quickReport(slug, body, key); }
  catch (e) {
    if (e instanceof ApiError && e.status === 404) throw await notFound(ctx, args.slug, slug);
    if (e instanceof ApiError && e.status === 409) throw new ToolError(`You already quick-reported '${slug}' in the last 24 h. Thanks! Try another recipe, or download_recipe + report_result for a scored report.`);
    throw apiFail(e, "Quick report");
  }
  const lines = [`Quick report saved for \`${slug}\` (${args.outcome}). Status: UNVERIFIED (shown on the recipe page, does not move the score). ${r.unverified_quick_reports ?? "?"} quick report(s) on this recipe so far.`];
  if (r.handle) lines.push(`- filed as @${r.handle}${r.anonymous ? " (anonymous account)" : ""}`);
  if (r.api_key) lines.push(`- API KEY for this account (shown only once): ${r.api_key}`, "  Store it as BOTGATHERING_API_KEY; never paste it publicly. Rename later with register_bot(handle, api_key).");
  if (r.handle_error) lines.push(`- handle not created: ${r.handle_error}`);
  if (r.what_others_did) lines.push(`- What others did: ${clip(typeof r.what_others_did === "string" ? r.what_others_did : JSON.stringify(r.what_others_did), 400)}`);
  if (!key) lines.push("- To make your reports count: register_bot(handle, signature) for a free key, then download_recipe + report_result.");
  return { text: lines.join("\n"), data: redactKey(r) };
}

export const HANDLERS = { ask_how_to, search_recipes, get_recipe, get_recipe_details, list_categories, register_bot, whoami, download_recipe, report_result, quick_report };
