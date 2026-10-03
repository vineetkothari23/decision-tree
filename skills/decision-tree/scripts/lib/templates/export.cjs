"use strict";

/** Converting a tree's structure back into template data and files. */

const fs = require("node:fs");
const path = require("node:path");
const { TEMPLATE_VERSION } = require("../constants.cjs");
const { children } = require("../core/tree.cjs");
const { DTError, isDir, slugify } = require("../util.cjs");
const { parseYaml, stringifyYaml } = require("../yaml.cjs");
const { validateTemplate, validateTemplateName, countTemplateNodes } = require("./schema.cjs");
const { templateNameOf } = require("./lookup.cjs");

/** A tree's structure (non-root nodes, without statuses, comments or history) as template data. */
function treeToTemplate(tree, name) {
  validateTemplateName(name);
  const conv = (n) => {
    const type = n.type === "goal" ? "note" : n.type;
    const out = { title: n.title };
    if (type !== "question") out.type = type;
    if (type === "question" && n.kind) out.kind = n.kind;
    if (n.body) out.body = n.body;
    if (type === "option" && n.pros && n.pros.length) out.pros = [...n.pros];
    if (type === "option" && n.cons && n.cons.length) out.cons = [...n.cons];
    const kids = children(tree, n.id).map(conv);
    if (kids.length) out.children = kids;
    return out;
  };
  const nodes = children(tree, tree.root_id).map(conv);
  if (!nodes.length) throw new DTError(`tree ${JSON.stringify(tree.id)} has no nodes under the root goal to export`);
  const tpl = { template: TEMPLATE_VERSION, name, title: tree.title || name };
  if (tree.description) tpl.description = tree.description;
  tpl.nodes = nodes;
  return tpl;
}

/** Writes a tree's structure as a template file (YAML, or JSON for `.json`); `out` may be a directory. */
function exportTemplate(tree, out, name) {
  let file = path.resolve(out);
  if (isDir(file) || /[\\/]$/.test(out)) file = path.join(file, `${name || validateTemplateName(slugify(tree.id))}.yaml`);
  if (!/\.(ya?ml|json)$/i.test(file)) throw new DTError(`template file ${out} must end in .yaml, .yml or .json`);
  const fileName = templateNameOf(file);
  if (name && name !== fileName) {
    throw new DTError(`--name ${JSON.stringify(name)} must match the output file name ${JSON.stringify(fileName)} (or pass a directory to -o)`);
  }
  const data = treeToTemplate(tree, name || fileName);
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
