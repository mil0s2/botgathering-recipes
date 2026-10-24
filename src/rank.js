// Local relevance ranking used by ask_how_to (and the offline search fallback).
// BM25 over title / tags / summary / category with field weights, fused with the
// API's own ranking (reciprocal-rank fusion) and a small evidence prior
// (recipes with real reports and a good success rate rank a bit higher).
import { tokenize } from "./text.js";

const FIELDS = [["title", 3], ["tags", 2], ["summary", 1.2], ["category", 0.8], ["body", 0.3]];
const K1 = 1.2, B = 0.75;

function fieldTokens(doc) {
  const out = {};
  for (const [f] of FIELDS) {
    const v = doc[f];
    out[f] = tokenize(Array.isArray(v) ? v.join(" ") : String(v ?? "").replace(/,/g, " "));
  }
  return out;
}

/**
 * Ranks docs for a query.
 * @param {string} query
 * @param {object[]} docs   records with slug, title, summary, tags, category, optional body
 * @param {object}  opts    apiRank: Map slug -> 0-based rank from the API search
 * @returns {{doc, score, matched: string[]}[]} sorted best first, only docs matching at least one term
 */
export function rank(query, docs, { apiRank = new Map() } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !docs.length) return [];
  const toks = docs.map(fieldTokens);
  const N = docs.length;
  const avg = {};
  for (const [f] of FIELDS) avg[f] = toks.reduce((s, t) => s + t[f].length, 0) / N || 1;
  const df = new Map(terms.map((t) => [t, toks.filter((d) => FIELDS.some(([f]) => d[f].includes(t))).length]));
  const results = docs.map((doc, i) => {
    let bm = 0; const matched = new Set();
    for (const t of terms) {
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      for (const [f, w] of FIELDS) {
        const arr = toks[i][f]; if (!arr.length) continue;
        const tf = arr.reduce((n, x) => n + (x === t ? 1 : 0), 0);
        if (!tf) continue;
        if (f !== "body") matched.add(t);
        bm += w * idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * arr.length / avg[f]));
      }
    }
    const coverage = matched.size / terms.length;
    const r = apiRank.get(doc.slug);
    const rrf = r === undefined ? 0 : 1 / (3 + r);
    const reports = Number(doc.reports || 0);
    const prior = reports ? Math.min(0.15, 0.05 * Math.log2(1 + reports)) * (doc.success_rate == null ? 0.5 : 0.5 + doc.success_rate) : 0;
    return { doc, matched: [...matched], score: bm * (0.5 + coverage) + 4 * rrf + prior, bm };
  });
  return results.filter((x) => x.matched.length || apiRank.has(x.doc.slug)).sort((a, b) => b.score - a.score);
}

/** Keeps results that are reasonably close to the best one (avoids padding with weak matches). */
export function relevanceCut(ranked, n, ratio = 0.35) {
  if (!ranked.length) return [];
  const top = ranked[0].score;
  return ranked.filter((x) => x.score >= top * ratio).slice(0, n);
}

/** The most informative query words (longest, non-stop) for widening a search. */
export function keyTerms(query, n = 3) {
  return [...new Set(tokenize(query))].sort((a, b) => b.length - a.length).slice(0, n);
}
