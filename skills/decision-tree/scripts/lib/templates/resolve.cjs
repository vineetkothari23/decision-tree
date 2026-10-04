"use strict";

/**
 * Mode inheritance. A mode's parent is `extends:` (default: "default"), looked up like any template; a mode that
 * extends its own name inherits from the next one down the lookup order. Configs merge root-first (config/sections),
 * the result is finalized and the mode's own seed nodes are checked against it. Seed nodes are never inherited.
 */

const path = require("node:path");
const { DTError, realOrResolved } = require("../util.cjs");
const { LEGACY_CONFIG } = require("../config/legacy.cjs");
const { mergeConfig, finalizeConfig } = require("../config/sections.cjs");
const { checkNodes, isConfigured, templateFail } = require("./schema.cjs");
const { findTemplate, loadTemplate, templateDirs, templateFiles } = require("./lookup.cjs");

const DEFAULT_MODE = "default";
const MAX_DEPTH = 8;

const labelOf = (tpl) => `${JSON.stringify(tpl.name)}${tpl.path ? ` (${tpl.path})` : ""}`;
const keyOf = (tpl) => (tpl.path ? realOrResolved(tpl.path) : `draft:${tpl.name}`);

/** The template `tpl` inherits from, or null for the base mode (a `default` that extends nothing below it). */
function parentOf(store, tpl) {
  const name = tpl.extends || DEFAULT_MODE;
  const dirs = templateDirs(store);
  const own = tpl.path ? realOrResolved(tpl.path) : null;
  const at = tpl.path ? dirs.findIndex((d) => realOrResolved(d.dir) === realOrResolved(path.dirname(tpl.path))) : -1;
  for (let i = 0; i < dirs.length; i++) {
    if (name === tpl.name && i <= at) continue;
    const [file] = templateFiles(dirs[i].dir, name);
    if (file && realOrResolved(file) !== own) return loadTemplate(file, dirs[i].source);
  }
  if (name === tpl.name && !tpl.extends) return null;
  const where = name === tpl.name ? `no lower-precedence mode named ${JSON.stringify(name)} exists` : "not found";
  throw new DTError(`template ${labelOf(tpl)}: extends: ${JSON.stringify(name)} ${where}; run \`dtree modes\` to list them`);
}

/** `tpl` with `resolved_config` (null for legacy templates) and its inheritance `chain` (leaf first). */
function withConfig(store, tpl) {
  if (!isConfigured(tpl)) return { ...tpl, resolved_config: null, chain: [tpl.name] };
  const fail = templateFail(labelOf(tpl));
  const chain = [tpl];
  const seen = new Set([keyOf(tpl)]);
  let base = {};
  for (let cur = tpl; ;) {
    const parent = parentOf(store, cur);
    if (!parent) break;
    const names = () => [...chain, parent].map((t) => t.name).join(" -> ");
    if (seen.has(keyOf(parent))) fail("extends", `inheritance cycle: ${names()}`);
    if (chain.length >= MAX_DEPTH) fail("extends", `inherits through more than ${MAX_DEPTH} modes: ${names()}`);
    chain.push(parent);
    seen.add(keyOf(parent));
    if (!isConfigured(parent)) {
      base = LEGACY_CONFIG;
      break;
    }
    cur = parent;
  }
  const merged = [...chain].reverse().reduce((acc, t) => mergeConfig(acc, t.config || {}), base);
  const resolved = finalizeConfig(merged, fail);
  checkNodes(tpl.nodes, resolved, fail);
  return { ...tpl, resolved_config: resolved, chain: chain.map((t) => t.name) };
}

/** Finds a template by path or name and resolves its inheritance. */
const resolveTemplate = (store, arg, options) => withConfig(store, findTemplate(store, arg, options));

/** The resolved config a mode named `name` with parent `parentName` would inherit (as if saved to `dir`). */
function inheritedConfig(store, name, parentName, dir) {
  const stub = { name, extends: parentName || null, config: {}, path: path.join(dir, `${name}.yaml`) };
  const parent = parentOf(store, stub);
  if (!parent) return {};
  return withConfig(store, parent).resolved_config || LEGACY_CONFIG;
}

/**
 * What a configured tree saved as mode `name` (in `dir`) extends: its draft's parent, else the mode it was created
 * from, else `default`, as `{name, config}`. Null for legacy trees.
 */
function treeParent(store, tree, name, dir) {
  if (!tree.config) return null;
  const wanted = tree.draft ? tree.draft.extends : tree.template;
  for (const parentName of [wanted, DEFAULT_MODE]) {
    if (!parentName) continue;
    try {
      const config = inheritedConfig(store, name, parentName, dir);
      if (Object.keys(config).length) return { name: parentName, config };
    } catch (e) {
      if (!(e instanceof DTError)) throw e;
    }
  }
  return { name: DEFAULT_MODE, config: {} };
}

module.exports = { DEFAULT_MODE, MAX_DEPTH, withConfig, resolveTemplate, inheritedConfig, treeParent };
