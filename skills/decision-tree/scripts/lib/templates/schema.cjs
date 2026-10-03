"use strict";

/** Template validation and normalization. */

const { NODE_TYPES, KINDS, STATUSES, TREE_STATUSES, TEMPLATE_VERSION, TEMPLATE_NAME_RE, TEMPLATE_KEYS, TEMPLATE_NODE_KEYS } = require("../constants.cjs");
const { DTError, isPlainObject } = require("../util.cjs");

/** Validates parsed template data and returns it normalized (defaults filled in). */
function validateTemplate(data, { label, name = null }) {
  const fail = (where, msg) => {
    throw new DTError(`template ${label}: ${where ? `${where}: ` : ""}${msg}`);
  };
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
  const list = (v, where) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail(where, "must be a list");
    return v;
  };
  const strings = (v, where, key) => {
    const items = typeof v === "string" ? [v] : list(v, where ? `${where}.${key}` : key);
    return items.map((x, k) => text(x, `${where}.${key}[${k}]`, key).trim()).filter(Boolean);
  };
  const node = (raw, where) => {
    if (!isPlainObject(raw)) fail(where, "must be a mapping with at least a title");
    for (const k of Object.keys(raw)) {
      if (!TEMPLATE_NODE_KEYS.includes(k)) fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${TEMPLATE_NODE_KEYS.join(", ")})`);
    }
    const nodeTitle = text(raw.title, where, "title").trim();
    if (!nodeTitle) fail(where, 'missing required "title"');
    const type = raw.type ?? "question";
    if (type === "goal") fail(where, 'type "goal" is reserved for the root; use question, option, decision, task or note');
    if (!Object.keys(NODE_TYPES).includes(type)) {
      fail(where, `invalid type ${JSON.stringify(type)}; expected one of: question, option, decision, task, note`);
    }
    const kind = raw.kind ?? null;
    if (kind !== null) {
      if (type !== "question") fail(where, `"kind" is only allowed on questions (this node is a ${type})`);
      if (!KINDS.includes(kind)) fail(where, `invalid kind ${JSON.stringify(kind)}; expected one of: ${KINDS.join(", ")}`);
    }
    const status = raw.status ?? "open";
    if (!STATUSES.includes(status)) fail(where, `invalid status ${JSON.stringify(status)}; expected one of: ${STATUSES.join(", ")}`);
    for (const key of ["pros", "cons"]) {
      if (raw[key] !== undefined && raw[key] !== null && type !== "option") {
        fail(where, `${JSON.stringify(key)} is only allowed on options (this node is a ${type})`);
      }
    }
    return {
      title: nodeTitle,
      type,
      kind,
      body: text(raw.body, where, "body").replace(/\n+$/, ""),
      status,
      assignee: text(raw.assignee, where, "assignee").trim(),
      pros: strings(raw.pros, where, "pros"),
      cons: strings(raw.cons, where, "cons"),
      children: list(raw.children, `${where}.children`).map((c, k) => node(c, `${where}.children[${k}]`)),
    };
  };
  const nodes = list(data.nodes, "nodes");
  if (!nodes.length) fail("nodes", "must be a non-empty list of nodes to add under the root goal");
  return {
    template: TEMPLATE_VERSION,
    name: data.name,
    title,
    description: text(data.description, "description", "description").replace(/\n+$/, ""),
    tree_status: treeStatus,
    nodes: nodes.map((n, k) => node(n, `nodes[${k}]`)),
  };
}

function validateTemplateName(name) {
  if (typeof name !== "string" || !TEMPLATE_NAME_RE.test(name)) {
    throw new DTError(`invalid template name ${JSON.stringify(name)}: use lowercase letters, digits, '-' and '_'`);
  }
  return name;
}


const countTemplateNodes = (nodes) => nodes.reduce((acc, n) => acc + 1 + countTemplateNodes(n.children), 0);

module.exports = { validateTemplate, validateTemplateName, countTemplateNodes };
