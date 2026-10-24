// Text helpers: slug normalisation, tokenising, similarity, and a local
// personal-data / secret pre-check run before anything is sent upstream.

export function kebab(s) { return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

/** Accepts a slug, 'slug.md', a recipe URL (/recipe/x, /recipes/x, /api/recipes/x/...) or a title; returns a kebab slug. */
export function normalizeSlug(input) {
  let s = String(input ?? "").trim().toLowerCase();
  const m = s.match(/\/(?:api\/)?recipes?\/([^/?#\s]+)/);
  if (m) s = m[1];
  s = s.split("?")[0].split("#")[0];
  if (s.endsWith(".md")) s = s.slice(0, -3);
  return kebab(s).slice(0, 200);
}

const STOP = new Set("a an and are as at be by can do does for from get how i in into is it its me my of on or our set so that the this to up use using want we what when with you your".split(" "));

export function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(s, { keepStop = false } = {}) {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => w && (keepStop || (!STOP.has(w) && w.length > 1))).map(stem);
}

/** Similarity of two strings in [0,1] (bigram Dice coefficient). */
export function similarity(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2); const n = grams.get(g); if (n) { hit++; grams.set(g, n - 1); } }
  return (2 * hit) / (a.length + b.length - 2);
}

/** Closest slugs to a guess, best first. */
export function suggestSlugs(guess, slugs, n = 3) {
  const q = kebab(guess);
  if (!q) return [];
  const qw = new Set(q.split("-").filter((w) => w.length > 2));
  const score = (s) => {
    const sw = new Set(s.split("-"));
    const overlap = qw.size ? [...qw].filter((w) => sw.has(w)).length / qw.size : 0;
    return overlap + similarity(q, s) + (s.startsWith(q.slice(0, 25)) || q.startsWith(s.slice(0, 25)) ? 0.6 : 0);
  };
  return slugs.map((s) => [s, score(s)]).filter(([, v]) => v >= 0.55).sort((x, y) => y[1] - x[1]).slice(0, n).map(([s]) => s);
}

const PII = [
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, "an email address"],
  [/\bbb_[A-Za-z0-9_-]{10,}/, "a BotGathering API key"],
  [/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{10,}/, "an API token"],
];
/** Returns a reason string if free text looks like it contains personal data or a secret, else null.
 *  Deliberately conservative (the BotGathering API runs its own, stricter scanner). */
export function personalDataProblem(text) {
  const t = String(text ?? "");
  for (const [re, what] of PII) if (re.test(t)) return `looks like it contains ${what}`;
  const noDates = t.replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
  for (const m of noDates.matchAll(/\+?\d[\d ().-]{7,}\d/g)) if (m[0].replace(/\D/g, "").length >= 9) return "looks like it contains a phone, ID or account number";
  return null;
}
