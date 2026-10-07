"use strict";

/**
 * Sub-tree expansion: every `type: tree` template node gets its mode's resolved `config` and, unless it lists its
 * own `children`, the mode's seed nodes, recursively. Explicit children are checked against the sub-mode's config.
 */

const { DTError } = require("../util.cjs");
const { LEGACY_CONFIG } = require("../config/legacy.cjs");
const { checkNodes, templateFail } = require("./schema.cjs");
const { MAX_DEPTH, resolveTemplate } = require("./resolve.cjs");

const clone = (v) => JSON.parse(JSON.stringify(v));

/** `{mode, config, nodes}` for a sub-tree of mode `name`; `chain` is the enclosing mode names (cycle check). */
function resolveSubtree(store, name, { seed = true, chain = [], where = "mode" } = {}) {
  const path = [...chain, name];
  const fail = templateFail(JSON.stringify(chain[0] ?? name));
  if (chain.includes(name)) fail(where, `sub-tree cycle: ${path.join(" -> ")}`);
  if (path.length > MAX_DEPTH) fail(where, `sub-trees nest more than ${MAX_DEPTH} modes deep: ${path.join(" -> ")}`);
  let sub;
  try {
    sub = resolveTemplate(store, name, { allowPath: false });
  } catch (e) {
    if (e instanceof DTError && chain.length) fail(where, e.message);
    throw e;
  }
  const config = clone(sub.resolved_config || LEGACY_CONFIG);
  const nodes = expandNodes(store, seed ? clone(sub.nodes) : [], { seed, chain: path, where: `${where} ${name}: nodes` });
  return { mode: name, config, nodes };
}

function expandNodes(store, nodes, { seed, chain, where }) {
  return nodes.map((n, k) => {
    const at = `${where}[${k}]`;
    if (n.type !== "tree") return { ...n, children: expandNodes(store, n.children, { seed, chain, where: `${at}.children` }) };
    if (n.config) return n;
    const sub = resolveSubtree(store, n.mode, { seed, chain, where: `${at}.mode` });
    if (!n.children) return { ...n, config: sub.config, children: sub.nodes };
    const own = checkNodes(clone(n.children), sub.config, templateFail(`${JSON.stringify(chain[0])} sub-tree ${JSON.stringify(n.mode)}`));
    return { ...n, config: sub.config, children: expandNodes(store, own, { seed, chain: [...chain, n.mode], where: `${at}.children` }) };
  });
}

/** `tpl` with its sub-trees expanded (already expanded ones are kept); `seed: false` keeps only explicit children (mode drafts). */
const expandSubtrees = (store, tpl, { seed = true } = {}) =>
  ({ ...tpl, nodes: expandNodes(store, tpl.nodes, { seed, chain: [tpl.name], where: "nodes" }) });

/** resolveTemplate plus sub-tree expansion: what a new tree is created from. */
const resolveMode = (store, arg, options) => expandSubtrees(store, resolveTemplate(store, arg, options));

module.exports = { resolveSubtree, expandSubtrees, resolveMode };
