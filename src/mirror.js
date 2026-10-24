// Offline fallback: the repository ships a markdown mirror of every public
// recipe in ../recipes. When the BotGathering API is unreachable the server
// can still search and serve these (clearly labelled as a possibly stale copy).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIRROR_DIR = fileURLToPath(new URL("../recipes/", import.meta.url));

/** Parses one mirrored recipe file into a catalog-like record. */
export function parseMirrorFile(slug, md) {
  const line = (re) => (md.match(re) || [])[1];
  const meta = md.match(/^- Recipe: (.+?) \(v(\d+), category ([^)]+)\)\s*$/m);
  const headline = line(/^# (.+)$/m) || slug;
  const lead = md.split(/\r?\n/).find((l, i, a) => i > 0 && l.trim() && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("- ") && a.slice(0, i).some((x) => x.startsWith("- URL:"))) || "";
  return {
    slug,
    title: meta ? meta[1] : headline,
    version: meta ? Number(meta[2]) : undefined,
    category_name: meta ? meta[3] : undefined,
    summary: lead.trim(),
    url: line(/^- URL: (\S+)/m) || `https://botgathering.com/recipe/${slug}`,
    status: line(/^- (Tested by .+)$/m),
    body: md,
    source: "mirror",
  };
}

export class Mirror {
  constructor(dir = DEFAULT_MIRROR_DIR) { this.dir = dir; this._all = null; }
  available() { return existsSync(this.dir); }
  all() {
    if (this._all) return this._all;
    if (!this.available()) return (this._all = []);
    this._all = readdirSync(this.dir).filter((f) => f.endsWith(".md")).sort()
      .map((f) => { const slug = f.slice(0, -3); return parseMirrorFile(slug, readFileSync(join(this.dir, f), "utf8")); });
    return this._all;
  }
  get(slug) { return this.all().find((r) => r.slug === slug) || null; }
}
