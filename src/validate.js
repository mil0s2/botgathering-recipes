// Minimal JSON-Schema validator for tool arguments (the subset our schemas use):
// type (string|integer|number|boolean|object), enum, minimum, maximum,
// minLength, maxLength, pattern, required, additionalProperties:false.
// Lenient coercion for what LLM clients often send: "3" -> 3, "true" -> true.

export class ValidationError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.name = "ValidationError";
    this.problems = problems;
  }
}

function coerce(value, type) {
  if (type === "integer" || type === "number") {
    if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) return Number(value);
  }
  if (type === "boolean" && typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  return value;
}

function checkType(v, type) {
  switch (type) {
    case "string": return typeof v === "string";
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    default: return true;
  }
}

/** Validates and returns a cleaned copy of args. Throws ValidationError. */
export function validateArgs(schema, input) {
  const args = input == null ? {} : input;
  if (!checkType(args, "object")) throw new ValidationError(["arguments must be a JSON object"]);
  const props = schema.properties || {};
  const out = {};
  const problems = [];
  for (const [k, raw] of Object.entries(args)) {
    const p = props[k];
    if (!p) {
      if (schema.additionalProperties === false) problems.push(`unknown argument '${k}' (allowed: ${Object.keys(props).join(", ") || "none"})`);
      continue;
    }
    if (raw === null || raw === undefined || raw === "") continue; // treat empty as omitted
    let v = coerce(raw, p.type);
    if (typeof v === "string") v = v.trim();
    if (!checkType(v, p.type)) { problems.push(`'${k}' must be ${p.type === "integer" ? "an integer" : "a " + p.type}`); continue; }
    if (p.enum && !p.enum.includes(v)) { problems.push(`'${k}' must be one of: ${p.enum.join(", ")} (got '${String(v).slice(0, 40)}')`); continue; }
    if (typeof v === "number") {
      if (p.minimum !== undefined && v < p.minimum) { problems.push(`'${k}' must be >= ${p.minimum}`); continue; }
      if (p.maximum !== undefined && v > p.maximum) { problems.push(`'${k}' must be <= ${p.maximum}`); continue; }
    }
    if (typeof v === "string") {
      if (p.minLength !== undefined && v.length < p.minLength) { problems.push(`'${k}' must be at least ${p.minLength} characters`); continue; }
      if (p.maxLength !== undefined && v.length > p.maxLength) { problems.push(`'${k}' must be at most ${p.maxLength} characters (got ${v.length})`); continue; }
      if (p.pattern && !new RegExp(p.pattern).test(v)) { problems.push(`'${k}' has an invalid format${p["x-format-hint"] ? ": " + p["x-format-hint"] : ""}`); continue; }
    }
    out[k] = v;
  }
  for (const r of schema.required || []) if (out[r] === undefined && !problems.some((x) => x.startsWith(`'${r}'`))) problems.push(`missing required argument '${r}'`);
  if (problems.length) throw new ValidationError(problems);
  for (const [k, p] of Object.entries(props)) if (out[k] === undefined && p.default !== undefined) out[k] = p.default;
  return out;
}
