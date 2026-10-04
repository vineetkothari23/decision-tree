"use strict";

/**
 * Structural locks. `children`: no direct children may be added, moved in/out or deleted.
 * `subtree`: the same anywhere beneath the node. Edits, statuses and comments are never locked.
 */

const { DTError, choice } = require("../../util.cjs");

const LOCKS = ["children", "subtree"];

const lockValue = (value) => (value === null || value === undefined || value === "" || value === "none" ? null : choice(value, LOCKS, "lock"));

/** The node whose lock forbids changing the children of `parentId`, if any. */
function lockingNode(tree, parentId) {
  const seen = new Set();
  let n = tree.nodes[parentId];
  let direct = true;
  while (n && !seen.has(n.id)) {
    seen.add(n.id);
    if (n.lock === "subtree" || (direct && n.lock === "children")) return n;
    direct = false;
    n = n.parent ? tree.nodes[n.parent] : null;
  }
  return null;
}

function assertUnlocked(tree, parentId, action) {
  const by = lockingNode(tree, parentId);
  if (!by) return;
  const scope = by.lock === "children" ? "its direct children" : "anywhere beneath it";
  throw new DTError(`cannot ${action}: ${by.id} is locked (${by.lock}); nodes cannot be added, moved or deleted in ${scope}. ` +
    `Unlock it first (dtree unlock ${tree.id} ${by.id})`);
}

module.exports = { LOCKS, lockValue, lockingNode, assertUnlocked };
