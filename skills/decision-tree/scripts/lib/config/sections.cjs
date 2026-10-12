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
const { NODE_TYPES } = require("../constants.cjs");
const { parseRules, checkRules } = require("./rules-schema.cjs");

const NODE_TYPE_KEYS = ["name", "prefix", "description", "color", "root", "default", "kinds", "fields", "statuses", "rules"];
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const CHOOSE_KEYS = ["type", "chosen", "siblings", "parent"];

/** `features.choose`: which node type is chosen, and the statuses choosing sets (default: from status roles). */
function parseChoose(v, where, fail) {
  if (v === false) return null;
  if (!isPlainObject(v)) fail(where, `must be a mapping with: ${CHOOSE_KEYS.join(", ")}`);
  for (const [k, x] of Object.entries(v)) {
    if (!CHOOSE_KEYS.includes(k)) fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${CHOOSE_KEYS.join(", ")})`);
    if (typeof x !== "string") fail(`${where}.${k}`, "must be an id");
    checkId(x, `${where}.${k}`, fail);
  }
  if (!v.type) fail(where, 'missing "type": the node type that gets chosen');
  return { ...v };
}

const CONFIG_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const FIELD_TYPES = ["text", "text_body", "list"];
/** Fields stored directly on nodes, and the types each may be configured as. */
const BUILTIN_FIELDS = { body: ["text_body", "text"], pros: ["list"], cons: ["list"], rationale: ["text_body", "text"], assignee: ["text"] };

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function checkId(id, where, fail) {
  if (!CONFIG_ID_RE.test(id)) fail(where, `invalid id ${JSON.stringify(id)}: use lowercase letters, digits, '-' and '_', starting with a letter`);
}

function idList(v, where, fail) {
  if (!Array.isArray(v)) fail(where, "must be a list of ids");
  v.forEach((x, i) => (typeof x === "string" ? checkId(x, `${where}[${i}]`, fail) : fail(`${where}[${i}]`, "must be a string")));
  const dup = v.find((x, i) => v.indexOf(x) !== i);
  if (dup !== undefined) fail(where, `${JSON.stringify(dup)} is listed twice`);
  return [...v];
}

function bool(v, where, fail) {
  if (typeof v !== "boolean") fail(where, "must be true or false");
  return v;
}

function entriesSection(keys, finalizeEntry, { keyParsers = {} } = {}) {
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
        const parsed = {};
        for (const [k, v] of Object.entries(entry)) {
          if (!keys.includes(k)) fail(at, `unknown key ${JSON.stringify(k)} (allowed: ${keys.join(", ")})`);
          if (hasOwn(keyParsers, k)) parsed[k] = v === null ? null : keyParsers[k](v, `${at}.${k}`, fail);
          else if (typeof v !== "string") fail(at, `${JSON.stringify(k)} must be a string`);
          else parsed[k] = v;
        }
        out[id] = parsed;
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
    if (spec[k].parse) return spec[k].parse(v, at, fail);
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
      for (const k of Object.keys(raw)) {
        if (!hasOwn(spec, k)) fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${Object.keys(spec).join(", ")})`);
      }
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === null ? null : (check(k, v, `${where}.${k}`, fail) ?? clone(v))]));
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
  node_types: entriesSection(NODE_TYPE_KEYS, (id, e, at, fail) => {
    if (hasOwn(NODE_TYPES, id)) fail(at, `node type ${JSON.stringify(id)} is built in`);
    if (!e.name || !e.name.trim()) fail(at, 'missing "name"');
    const prefix = e.prefix ?? id[0];
    if (!/^[a-z]{1,3}$/.test(prefix)) fail(`${at}.prefix`, "must match /^[a-z]{1,3}$/");
    if (e.color !== undefined && e.color !== null && !COLOR_RE.test(e.color)) fail(`${at}.color`, "must be a #rgb or #rrggbb color");
    const out = { prefix, kinds: e.kinds || [] };
    for (const k of ["color", "fields", "statuses"]) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
    for (const k of ["root", "default"]) if (e[k]) out[k] = true;
    if (e.rules && e.rules.length) out.rules = e.rules;
    return out;
  }, { keyParsers: { kinds: idList, fields: idList, statuses: idList, rules: parseRules, root: bool, default: bool } }),
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
  features: settingsSection({ assignee: { type: "boolean", default: false }, choose: { parse: parseChoose, default: null } }),
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

function checkNodeTypes(cfg, where, fail) {
  const types = Object.entries(cfg.node_types);
  for (const flag of ["root", "default"]) {
    const marked = types.filter(([, t]) => t[flag]).map(([id]) => id);
    if (marked.length > 1) fail(where, `only one node type can be ${flag}: true (${marked.join(", ")})`);
  }
  for (const [id, t] of types) {
    for (const [key, section] of [["fields", "fields"], ["statuses", "statuses"]]) {
      for (const x of t[key] || []) if (!hasOwn(cfg[section], x)) fail(`${where}.${id}.${key}`, `${JSON.stringify(x)} is not in ${section}`);
    }
    if (t.statuses && !t.statuses.some((x) => cfg.statuses[x].role === "open")) fail(`${where}.${id}.statuses`, "needs a status with role open");
  }
}

function checkChoose(cfg, where, fail) {
  const c = cfg.features.choose;
  if (!c) return;
  if (!hasOwn(cfg.node_types, c.type) && !hasOwn(NODE_TYPES, c.type)) fail(`${where}.type`, `unknown node type ${JSON.stringify(c.type)}`);
  for (const k of ["chosen", "siblings", "parent"]) {
    if (c[k] && !hasOwn(cfg.statuses, c[k])) fail(`${where}.${k}`, `unknown status ${JSON.stringify(c[k])}`);
  }
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
  if (out.features.assignee && !hasOwn(out.fields, "assignee")) out.fields.assignee = { name: "Assignee", type: "text" };
  checkNodeTypes(out, `${where}.node_types`, fail);
  checkChoose(out, `${where}.features.choose`, fail);
  checkRules(out, new Set(ROLES), `${where}.node_types`, fail);
  return out;
}

const configFail = (label) => (where, msg) => {
  throw new DTError(`${label}: ${where ? `${where}: ` : ""}${msg}`);
};

module.exports = {
  CONFIG_ID_RE, FIELD_TYPES, BUILTIN_FIELDS, SECTIONS, SECTION_NAMES, parseConfig, mergeConfig, diffConfig, finalizeConfig, configFail,
};
