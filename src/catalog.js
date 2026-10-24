// Cached view of the whole public catalogue (all recipe summaries + categories),
// built from the paginated REST listing. Used for local ranking, slug resolution
// and "did you mean" suggestions. Falls back to the bundled markdown mirror.
import { kebab } from "./text.js";

export class Catalog {
  constructor(api, mirror, { ttlMs = 10 * 60 * 1000 } = {}) {
    this.api = api; this.mirror = mirror; this.ttlMs = ttlMs;
    this._recipes = null; this._recipesAt = 0; this._cats = null; this._catsAt = 0;
    this.source = null; // "api" | "mirror"
  }

  /** All recipes (summary records). Pages through GET /api/recipes?limit=100 (no query = not a search). */
  async recipes() {
    if (this._recipes && Date.now() - this._recipesAt < this.ttlMs) return this._recipes;
    try {
      const all = []; let offset = 0;
      for (let i = 0; i < 20; i++) {
        const page = await this.api.searchRecipes({ limit: 100, offset, sort: "score" });
        all.push(...(page.recipes || []));
        if (!page.has_more || !(page.recipes || []).length) break;
        offset += page.recipes.length;
      }
      this._recipes = all; this._recipesAt = Date.now(); this.source = "api";
    } catch (e) {
      if (!e.isNetwork || !this.mirror?.available()) throw e;
      this._recipes = this.mirror.all(); this._recipesAt = Date.now(); this.source = "mirror";
    }
    return this._recipes;
  }

  async categories() {
    if (this._cats && Date.now() - this._catsAt < this.ttlMs) return this._cats;
    const r = await this.api.listCategories();
    this._cats = r.categories || []; this._catsAt = Date.now();
    return this._cats;
  }

  /** Resolve what an agent passed (slug, URL, title) to an existing slug, or null. */
  async resolve(normalized, raw) {
    let list;
    try { list = await this.recipes(); } catch { return null; }
    if (list.some((r) => r.slug === normalized)) return normalized;
    const t = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const byTitle = list.find((r) => String(r.title).toLowerCase() === t) || list.find((r) => kebab(r.title) === normalized);
    if (byTitle) return byTitle.slug;
    // stored slugs are cut at ~60 chars: a longer kebab of the full title starts with the slug
    const prefix = list.find((r) => normalized.length > 40 && normalized.startsWith(r.slug));
    return prefix ? prefix.slug : null;
  }

  async slugs() { try { return (await this.recipes()).map((r) => r.slug); } catch { return []; } }
}
