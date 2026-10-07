"use strict";

/** Converting a tree's structure back into template data and files. */

const fs = require("node:fs");
const path = require("node:path");
const { TEMPLATE_VERSION } = require("../constants.cjs");
const { children } = require("../core/tree.cjs");
const { configAt } = require("../config/scope.cjs");
const { initialStatus } = require("../config/roles.cjs");
const { diffConfig } = require("../config/sections.cjs");
const { DTError, isDir, slugify } = require("../util.cjs");
const { parseYaml, stringifyYaml } = require("../yaml.cjs");
const { validateTemplate, validateTemplateName, countTemplateNodes } = require("./schema.cjs");
const { templateNameOf } = require("./lookup.cjs");

/**
 * A tree's structure (non-root nodes, without comments or history) as template data. Configured trees export
 * `extends: parent.name` plus their config as a diff against `parent.config`. Statuses and assignees are kept only
 * with `keepStatus` (mode drafts), since a worked tree's statuses are progress, not seed data.
 */
function treeToTemplate(tree, name, { parent = null, keepStatus = false } = {}) {
  validateTemplateName(name);
  const conv = (n) => {
    const type = n.type === "goal" ? "note" : n.type;
    const out = { title: n.title };
    if (type !== "question") out.type = type;
    if (type === "question" && n.kind) out.kind = n.kind;
    if (n.body) out.body = n.body;
    if (type === "option" && n.pros && n.pros.length) out.pros = [...n.pros];
    if (type === "option" && n.cons && n.cons.length) out.cons = [...n.cons];
    if (keepStatus && n.status !== initialStatus(configAt(tree, n.id))) out.status = n.status;
    if (keepStatus && n.assignee) out.assignee = n.assignee;
    if (n.labels && n.labels.length) out.labels = [...n.labels];
    if (n.lock) out.lock = n.lock;
    if (n.fields && Object.keys(n.fields).length) out.fields = JSON.parse(JSON.stringify(n.fields));
    const kids = children(tree, n.id).map(conv);
    if (kids.length) out.children = kids;
    return out;
  };
  const nodes = children(tree, tree.root_id).map(conv);
  if (!nodes.length && !tree.config) throw new DTError(`tree ${JSON.stringify(tree.id)} has no nodes under the root goal to export`);
  const tpl = { template: TEMPLATE_VERSION, name, title: tree.title || name };
  if (tree.description) tpl.description = tree.description;
  if (tree.config) {
    tpl.extends = parent ? parent.name : "default";
    const own = diffConfig(parent ? parent.config : {}, tree.config);
    if (Object.keys(own).length) tpl.config = own;
  }
  if (keepStatus && tree.status && tree.status !== "draft") tpl.tree_status = tree.status;
  tpl.nodes = nodes;
  return tpl;
}

/**
 * Writes a tree's structure as a template file (YAML, or JSON for `.json`); `out` may be a directory.
 * `options.parentFor(name, dir)` gives a configured tree's `{name, config}` parent (see resolve.treeParent).
 */
function exportTemplate(tree, out, name, options = {}) {
  let file = path.resolve(out);
  if (isDir(file) || /[\\/]$/.test(out)) file = path.join(file, `${name || validateTemplateName(slugify(tree.id))}.yaml`);
  if (!/\.(ya?ml|json)$/i.test(file)) throw new DTError(`template file ${out} must end in .yaml, .yml or .json`);
  const fileName = templateNameOf(file);
  if (name && name !== fileName) {
    throw new DTError(`--name ${JSON.stringify(name)} must match the output file name ${JSON.stringify(fileName)} (or pass a directory to -o)`);
  }
  const finalName = name || fileName;
  const parent = options.parentFor ? options.parentFor(finalName, path.dirname(file)) : null;
  const data = treeToTemplate(tree, finalName, { parent, keepStatus: options.keepStatus });
  const text = path.extname(file).toLowerCase() === ".json" ? JSON.stringify(data, null, 2) + "\n" : stringifyYaml(data);
  const tpl = validateTemplate(path.extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text, file), {
    label: JSON.stringify(data.name),
    name: data.name,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { name: tpl.name, path: file, nodes: countTemplateNodes(tpl.nodes) };
}

module.exports = { treeToTemplate, exportTemplate };
