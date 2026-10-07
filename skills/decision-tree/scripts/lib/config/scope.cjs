"use strict";

/**
 * Lexical config scope. A node of type `tree` with a `config` (a sub-tree) scopes its descendants; the tree node itself follows
 * its parent's scope. The file root is the implicit outermost scope (tree.config, or the legacy config).
 */

const { hasOwn } = require("../util.cjs");
const { treeConfig } = require("./legacy.cjs");

const isScope = (n) => Boolean(n && n.type === "tree" && n.config);

/** The nearest ancestor of `nid` (strictly above it) that opens a scope, or null for the file root. */
function scopeNode(tree, nid) {
  const seen = new Set([nid]);
  let id = hasOwn(tree.nodes, nid) ? tree.nodes[nid].parent : null;
  while (id && hasOwn(tree.nodes, id) && !seen.has(id)) {
    seen.add(id);
    const n = tree.nodes[id];
    if (isScope(n)) return n;
    id = n.parent;
  }
  return null;
}

/** The id of the node that opens `nid`'s scope: a tree node, or the root goal for the file scope. */
const scopeRoot = (tree, nid) => (scopeNode(tree, nid) || { id: tree.root_id }).id;

/** The config that governs node `nid`. */
const configAt = (tree, nid) => (scopeNode(tree, nid) || { config: treeConfig(tree) }).config;

/** The config that governs new children of `parentId` (the file's config when there is no parent). */
function configUnder(tree, parentId) {
  if (parentId === null || parentId === undefined) return treeConfig(tree);
  const parent = hasOwn(tree.nodes, parentId) ? tree.nodes[parentId] : null;
  return isScope(parent) ? parent.config : configAt(tree, parentId);
}

module.exports = { isScope, configAt, configUnder, scopeRoot };
