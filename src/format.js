// Output formatting: turns API records into compact, readable markdown for agents.

export const REPORT_TIP = "After trying a recipe, report it: quick_report(slug, outcome='success'|'partial'|'failure', notes='one line'). Failures improve recipes as much as successes.";

export function scoreLine(r) {
  const n = Number(r.reports || 0);
  const disp = r.score_display ?? (r.score != null ? String(r.score) : "Untested");
  const sr = r.success_rate != null ? `, ${Math.round(r.success_rate * 100)}% success` : "";
  if (!n) return `untested (0 full reports${disp && disp !== "Untested" ? "; " + disp : ""})`;
  return `${r.score_shown ? `score ${disp}/100` : disp}, ${n} report${n === 1 ? "" : "s"}${sr}`;
}

export function recipeListItem(r, i) {
  const tags = r.tags ? ` · tags: ${String(r.tags).split(",").filter(Boolean).join(", ")}` : "";
  return `${i + 1}. **${r.title}** (\`${r.slug}\`)\n   ${r.category || r.category_name || "?"} · ${scoreLine(r)}${tags}\n   ${r.summary || ""}\n   ${r.url || ""}`.trimEnd();
}

export function date(v) {
  if (v == null || v === "") return "";
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return isNaN(d) ? String(v) : d.toISOString().slice(0, 10);
}

export function maskEmail(e) {
  const s = String(e || "");
  const at = s.indexOf("@");
  if (at < 1) return s ? "(hidden)" : "";
  return s[0] + "***" + s.slice(at);
}

export function clip(s, n) { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

export function table(headers, rows) {
  const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}
