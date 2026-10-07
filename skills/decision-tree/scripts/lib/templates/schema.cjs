"use strict";

/**
 * Template validation and normalization. Structure is checked here; vocabulary (statuses, kinds, fields, labels)
 * is checked against a config by `checkNodes`: the legacy one for templates without `extends`/`config`, or the
 * inherited one once templates/resolve has resolved it.
 */

const { NODE_TYPES, TREE_STATUSES, TEMPLATE_VERSION, TEMPLATE_NAME_RE, TEMPLATE_KEYS, TEMPLATE_NODE_KEYS } = require("../constants.cjs");
const { DTError, isPlainObject, hasOwn } = require("../util.cjs");
const { LEGACY_CONFIG } = require("../config/legacy.cjs");
const { initialStatus } = require("../config/roles.cjs");
const { parseConfig, BUILTIN_FIELDS } = require("../config/sections.cjs");
const { LOCKS } = require("../core/policy/locks.cjs");

const templateFail = (label) => (where, msg) => {
  throw new DTError(`template ${label}: ${where ? `${where}: ` : ""}${msg}`);
};

/** True for templates that opt into modes (`extends` or `config`); others keep the legacy vocabulary. */
const isConfigured = (tpl) => tpl.extends !== null || tpl.config !== null;

/** Validates parsed template data and returns it normalized (defaults filled in). */
function validateTemplate(data, { label, name = null }) {
  const fail = templateFail(label);
  const text = (v, where, key) => {
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return fail(where, `${JSON.stringify(key)} must be a string`);
  };
  if (!isPlainObject(data)) fail("", "must be a mapping with template, name, title and nodes");
  for (const k of Object.keys(data)) {
    if (!TEMPLATE_KEYS.includes(k)) fail("", `unknown key ${JSON.stringify(k)} (allowed: ${TEMPLATE_KEYS.join(", ")})`);
  }
  if (data.template === undefined) fail("", `missing required key "template" (format version, use ${TEMPLATE_VERSION})`);
  if (data.template !== TEMPLATE_VERSION) {
    fail("template", `unsupported format version ${JSON.stringify(data.template)}; expected ${TEMPLATE_VERSION}`);
  }
  if (data.name === undefined || data.name === null) fail("", 'missing required key "name"');
  if (typeof data.name !== "string" || !TEMPLATE_NAME_RE.test(data.name)) {
    fail("name", `invalid name ${JSON.stringify(data.name)}: use lowercase letters, digits, '-' and '_'`);
  }
  if (name !== null && data.name !== name) fail("name", `${JSON.stringify(data.name)} must match the file name ${JSON.stringify(name)}`);
  const title = text(data.title, "title", "title").trim();
  if (!title) fail("", 'missing required key "title"');
  const treeStatus = data.tree_status ?? null;
  if (treeStatus !== null && !TREE_STATUSES.includes(treeStatus)) {
    fail("tree_status", `invalid tree status ${JSON.stringify(treeStatus)}; expected one of: ${TREE_STATUSES.join(", ")}`);
  }
  const parent = data.extends ?? null;
  if (parent !== null && (typeof parent !== "string" || !TEMPLATE_NAME_RE.test(parent))) {
    fail("extends", `must be the name of another mode, got ${JSON.stringify(parent)}`);
  }
  const config = hasOwn(data, "config") ? parseConfig(data.config, fail) : null;
  const list = (v, where) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail(where, "must be a list");
    return v;
  };
  const strings = (v, where, key) => {
    const items = typeof v === "string" ? [v] : list(v, where ? `${where}.${key}` : key);
    return items.map((x, k) => text(x, `${where}.${key}[${k}]`, key).trim()).filter(Boolean);
  };
  const id = (v, where, key) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || !v) fail(where, `${JSON.stringify(key)} must be a string`);
    return v;
  };
  const node = (raw, where) => {
    if (!isPlainObject(raw)) fail(where, "must be a mapping with at least a title");
    for (const k of Object.keys(raw)) {
      if (!TEMPLATE_NODE_KEYS.includes(k)) fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${TEMPLATE_NODE_KEYS.join(", ")})`);
    }
    const nodeTitle = text(raw.title, where, "title").trim();
    if (!nodeTitle) fail(where, 'missing required "title"');
    const type = raw.type ?? "question";
    if (type === "goal") fail(where, 'type "goal" is reserved for the root; use question, option, decision, task, note or tree');
    if (!Object.keys(NODE_TYPES).includes(type)) {
      fail(where, `invalid type ${JSON.stringify(type)}; expected one of: question, option, decision, task, note, tree`);
    }
    const mode = raw.mode ?? null;
    if (type === "tree" && (typeof mode !== "string" || !TEMPLATE_NAME_RE.test(mode))) {
      fail(where, `a tree node needs "mode": a template name (lowercase letters, digits, '-' and '_'), got ${JSON.stringify(mode)}`);
    }
    if (type !== "tree" && mode !== null) fail(where, `"mode" is only allowed on tree nodes (this node is a ${type})`);
    const kind = id(raw.kind, where, "kind");
    if (kind !== null && type !== "question") fail(where, `"kind" is only allowed on questions (this node is a ${type})`);
    for (const key of ["pros", "cons"]) {
      if (raw[key] !== undefined && raw[key] !== null && type !== "option") {
        fail(where, `${JSON.stringify(key)} is only allowed on options (this node is a ${type})`);
      }
    }
    const out = {
      title: nodeTitle,
      type,
      ...(type === "tree" ? { mode } : {}),
      kind,
      body: text(raw.body, where, "body").replace(/\n+$/, ""),
      status: id(raw.status, where, "status"),
      assignee: text(raw.assignee, where, "assignee").trim(),
      pros: strings(raw.pros, where, "pros"),
      cons: strings(raw.cons, where, "cons"),
    };
    const rationale = text(raw.rationale, where, "rationale").replace(/\n+$/, "");
    if (rationale) out.rationale = rationale;
    const labels = strings(raw.labels, where, "labels");
    if (labels.length) out.labels = labels;
    if (raw.lock !== undefined && raw.lock !== null) {
      if (!LOCKS.includes(raw.lock)) fail(where, `invalid lock ${JSON.stringify(raw.lock)}; expected one of: ${LOCKS.join(", ")}`);
      out.lock = raw.lock;
    }
    if (raw.fields !== undefined && raw.fields !== null) {
      if (!isPlainObject(raw.fields)) fail(where, '"fields" must be a mapping of field id to value');
      const fields = {};
      for (const [fid, v] of Object.entries(raw.fields)) {
        if (hasOwn(BUILTIN_FIELDS, fid)) fail(`${where}.fields`, `${JSON.stringify(fid)} is a built-in field; set it on the node itself`);
        const value = Array.isArray(v) ? strings(v, `${where}.fields`, fid) : text(v, `${where}.fields`, fid).replace(/\n+$/, "");
        if (value.length) fields[fid] = value;
      }
      if (Object.keys(fields).length) out.fields = fields;
    }
    const own = type !== "tree" || (raw.children !== undefined && raw.children !== null);
    out.children = own ? list(raw.children, `${where}.children`).map((c, k) => node(c, `${where}.children[${k}]`)) : null;
    return out;
  };
  const nodes = list(data.nodes, "nodes");
  const tpl = {
    template: TEMPLATE_VERSION,
    name: data.name,
    title,
    description: text(data.description, "description", "description").replace(/\n+$/, ""),
    extends: parent,
    tree_status: treeStatus,
    config,
    nodes: nodes.map((n, k) => node(n, `nodes[${k}]`)),
  };
  if (!isConfigured(tpl)) {
    if (!nodes.length) fail("nodes", "must be a non-empty list of nodes to add under the root goal (or give the mode `extends:`/`config:`)");
    checkNodes(tpl.nodes, LEGACY_CONFIG, fail);
  }
  return tpl;
}

/** Checks template nodes against a resolved config and fills in each node's default status. */
function checkNodes(nodes, cfg, fail) {
  const known = (value, allowed, what, where) => {
    if (!allowed.includes(value)) {
      fail(where, allowed.length
        ? `invalid ${what} ${JSON.stringify(value)}; expected one of: ${allowed.join(", ")}`
        : `invalid ${what} ${JSON.stringify(value)}: this mode defines no ${what}s`);
    }
  };
  const walk = (list, prefix) => list.forEach((n, k) => {
    const where = `${prefix}[${k}]`;
    if (n.kind !== null) known(n.kind, cfg.kinds, "kind", where);
    n.status = n.status ?? initialStatus(cfg);
    known(n.status, Object.keys(cfg.statuses), "status", where);
    for (const l of n.labels || []) known(l, cfg.labels, "label", where);
    for (const f of ["body", "assignee", "pros", "cons", "rationale"]) {
      if (n[f] && n[f].length && !hasOwn(cfg.fields, f)) fail(where, `field ${JSON.stringify(f)} is not part of this mode`);
    }
    for (const [f, v] of Object.entries(n.fields || {})) {
      if (!hasOwn(cfg.fields, f)) fail(`${where}.fields`, `field ${JSON.stringify(f)} is not part of this mode`);
      if ((cfg.fields[f].type === "list") !== Array.isArray(v)) {
        fail(`${where}.fields`, `field ${JSON.stringify(f)} must be ${cfg.fields[f].type === "list" ? "a list" : "text"}`);
      }
    }
    if (n.type !== "tree") walk(n.children, `${where}.children`);
  });
  walk(nodes, "nodes");
  return nodes;
}

function validateTemplateName(name) {
  if (typeof name !== "string" || !TEMPLATE_NAME_RE.test(name)) {
    throw new DTError(`invalid template name ${JSON.stringify(name)}: use lowercase letters, digits, '-' and '_'`);
  }
  return name;
}

const countTemplateNodes = (nodes) => nodes.reduce((acc, n) => acc + 1 + countTemplateNodes(n.children || []), 0);

module.exports = { validateTemplate, validateTemplateName, countTemplateNodes, checkNodes, isConfigured, templateFail };
