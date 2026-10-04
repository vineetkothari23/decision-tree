"use strict";

/**
 * The sections of a mode's `config:` and how each one is parsed, inherited (merged), diffed and finalized.
 * A new section is one more entry in SECTIONS; nothing else in the resolver changes.
 *
 * - entries:  `id: {key: value}` maps (fields, link_types, statuses). Child entries merge key by key over the
 *             parent's; `id: null` removes an inherited entry.
 * - settings: fixed keys with defaults (comments, review). Child keys override; `key: null` resets the default.
 * - list:     plain lists of ids (kinds, labels). A child list replaces the parent's.
 */

const { DTError, isPlainObject, hasOwn, same } = require("../util.cjs");
const { ROLES, REQUIRED_ROLES } = require("./roles.cjs");

const CONFIG_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const FIELD_TYPES = ["text", "text_body", "list"];
/** Fields stored directly on nodes, and the types each may be configured as. */
const BUILTIN_FIELDS = { body: ["text_body", "text"], pros: ["list"], cons: ["list"], rationale: ["text_body", "text"], assignee: ["text"] };

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function checkId(id, where, fail) {
  if (!CONFIG_ID_RE.test(id)) fail(where, `invalid id ${JSON.stringify(id)}: use lowercase letters, digits, '-' and '_', starting with a letter`);
}

function entriesSection(keys, finalizeEntry) {
  return {
    empty: () => ({}),
    parse(raw, where, fail) {
      if (!isPlainObject(raw)) fail(where, "must be a mapping of <id>: {name: ..., ...}");
      const out = {};
      for (const [id, entry] of Object.entries(raw)) {
        const at = `${where}.${id}`;
        checkId(id, at, fail);
        if (entry === null) {
          out[id] = null;
          continue;
        }
        if (!isPlainObject(entry)) fail(at, "must be a mapping (or null to remove an inherited entry)");
        for (const [k, v] of Object.entries(entry)) {
          if (!keys.includes(k)) fail(at, `unknown key ${JSON.stringify(k)} (allowed: ${keys.join(", ")})`);
          if (typeof v !== "string") fail(at, `${JSON.stringify(k)} must be a string`);
        }
        out[id] = { ...entry };
      }
      return out;
    },
    merge(parent, child) {
      const out = clone(parent);
      for (const [id, entry] of Object.entries(child)) {
        if (entry === null) delete out[id];
        else out[id] = { ...(out[id] || {}), ...entry };
      }
      return out;
    },
    diff(parent, child) {
      const out = {};
      for (const id of Object.keys(parent)) if (!hasOwn(child, id)) out[id] = null;
      for (const [id, entry] of Object.entries(child)) {
        if (!hasOwn(parent, id)) {
          out[id] = clone(entry);
          continue;
        }
        const changed = {};
        for (const k of new Set([...Object.keys(parent[id]), ...Object.keys(entry)])) {
          if (!same(parent[id][k], entry[k])) changed[k] = entry[k] ?? "";
        }
        if (Object.keys(changed).length) out[id] = changed;
      }
      return Object.keys(out).length ? out : undefined;
    },
    finalize(value, where, fail) {
      return Object.fromEntries(Object.entries(value).map(([id, e]) => {
        const out = { name: (e.name || "").trim() || id, ...finalizeEntry(id, e, `${where}.${id}`, fail) };
        if (e.description && e.description.trim()) out.description = e.description.replace(/\n+$/, "");
        return [id, out];
      }));
    },
  };
}

function settingsSection(spec) {
  const check = (k, v, at, fail) => {
    if (spec[k].type === "boolean" && typeof v !== "boolean") fail(at, "must be true or false");
    if (spec[k].type === "list") {
      if (!Array.isArray(v)) fail(at, "must be a list");
      v.forEach((x, i) => typeof x === "string" ? checkId(x, `${at}[${i}]`, fail) : fail(`${at}[${i}]`, "must be a string"));
    }
  };
  return {
    empty: () => ({}),
    parse(raw, where, fail) {
      if (!isPlainObject(raw)) fail(where, `must be a mapping with: ${Object.keys(spec).join(", ")}`);
      for (const [k, v] of Object.entries(raw)) {
        if (!hasOwn(spec, k)) fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${Object.keys(spec).join(", ")})`);
        if (v !== null) check(k, v, `${where}.${k}`, fail);
      }
      return clone(raw);
    },
    merge(parent, child) {
      const out = clone(parent);
      for (const [k, v] of Object.entries(child)) {
        if (v === null) delete out[k];
        else out[k] = clone(v);
      }
      return out;
    },
    diff(parent, child) {
      const out = {};
      for (const k of Object.keys(spec)) {
        const a = hasOwn(parent, k) ? parent[k] : spec[k].default;
        const b = hasOwn(child, k) ? child[k] : spec[k].default;
        if (!same(a, b)) out[k] = clone(b);
      }
      return Object.keys(out).length ? out : undefined;
    },
    finalize(value) {
      return Object.fromEntries(Object.keys(spec).map((k) => [k, clone(hasOwn(value, k) ? value[k] : spec[k].default)]));
    },
  };
}

const listSection = {
  empty: () => [],
  parse(raw, where, fail) {
    if (!Array.isArray(raw)) fail(where, "must be a list of ids");
    raw.forEach((x, i) => (typeof x === "string" ? checkId(x, `${where}[${i}]`, fail) : fail(`${where}[${i}]`, "must be a string")));
    const dup = raw.find((x, i) => raw.indexOf(x) !== i);
    if (dup !== undefined) fail(where, `${JSON.stringify(dup)} is listed twice`);
    return [...raw];
  },
  merge: (parent, child) => [...child],
  diff: (parent, child) => (same(parent, child) ? undefined : [...child]),
  finalize: (value) => [...value],
};

const SECTIONS = {
  fields: entriesSection(["name", "type", "description"], (id, e, at, fail) => {
    if (!e.type) fail(at, `missing "type" (one of: ${FIELD_TYPES.join(", ")})`);
    if (!FIELD_TYPES.includes(e.type)) fail(at, `invalid type ${JSON.stringify(e.type)}; expected one of: ${FIELD_TYPES.join(", ")}`);
    if (hasOwn(BUILTIN_FIELDS, id) && !BUILTIN_FIELDS[id].includes(e.type)) {
      fail(at, `the built-in field ${JSON.stringify(id)} must be of type ${BUILTIN_FIELDS[id].join(" or ")}`);
    }
    return { type: e.type };
  }),
  link_types: entriesSection(["name", "description"], () => ({})),
  statuses: entriesSection(["name", "role", "description"], (id, e, at, fail) => {
    if (!ROLES.includes(e.role)) fail(at, `"role" must be one of: ${ROLES.join(", ")}`);
    return { role: e.role };
  }),
  comments: settingsSection({ threads: { type: "boolean", default: true } }),
  review: settingsSection({ required_kinds: { type: "list", default: [] } }),
  kinds: listSection,
  labels: listSection,
};
const SECTION_NAMES = Object.keys(SECTIONS);

/** One mode file's own `config:` (partial, not inherited yet). */
function parseConfig(raw, fail, where = "config") {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) fail(where, `must be a mapping with any of: ${SECTION_NAMES.join(", ")}`);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!hasOwn(SECTIONS, k)) fail(where, `unknown section ${JSON.stringify(k)} (allowed: ${SECTION_NAMES.join(", ")})`);
    out[k] = v === null ? null : SECTIONS[k].parse(v, `${where}.${k}`, fail);
  }
  return out;
}

/** `child`'s sections inherited over `parent`'s (both partial). A null section resets it to empty. */
function mergeConfig(parent, child) {
  const out = clone(parent);
  for (const [k, v] of Object.entries(child)) out[k] = v === null ? SECTIONS[k].empty() : SECTIONS[k].merge(parent[k] ?? SECTIONS[k].empty(), v);
  return out;
}

/** The smallest own config that, merged over `parent`, gives `child` (both finalized). */
function diffConfig(parent, child) {
  const out = {};
  for (const [k, s] of Object.entries(SECTIONS)) {
    const d = s.diff(parent[k] ?? s.empty(), child[k] ?? s.empty());
    if (d !== undefined) out[k] = d;
  }
  return out;
}

/** A complete, validated config: every section present, required roles covered, review kinds known. */
function finalizeConfig(cfg, fail, where = "config") {
  const out = {};
  for (const [k, s] of Object.entries(SECTIONS)) out[k] = s.finalize(cfg[k] ?? s.empty(), `${where}.${k}`, fail);
  const roles = new Set(Object.values(out.statuses).map((s) => s.role));
  const missing = REQUIRED_ROLES.filter((r) => !roles.has(r));
  if (missing.length) fail(`${where}.statuses`, `needs a status with each of the roles ${REQUIRED_ROLES.join(", ")} (missing: ${missing.join(", ")})`);
  const unknown = out.review.required_kinds.filter((k) => !out.kinds.includes(k));
  if (unknown.length) fail(`${where}.review.required_kinds`, `${unknown.join(", ")} not in kinds`);
  return out;
}

const configFail = (label) => (where, msg) => {
  throw new DTError(`${label}: ${where ? `${where}: ` : ""}${msg}`);
};

module.exports = {
  CONFIG_ID_RE, FIELD_TYPES, BUILTIN_FIELDS, SECTIONS, SECTION_NAMES, parseConfig, mergeConfig, diffConfig, finalizeConfig, configFail,
};
