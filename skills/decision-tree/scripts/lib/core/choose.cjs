"use strict";

/** Choosing an option: it gets the tree's accepted status, its siblings the rejected one, its question is decided. */

const { DTError, hasOwn } = require("../util.cjs");
const { treeConfig } = require("../config/legacy.cjs");
const { hasRole, chosenStatus, decidedStatus, rejectedStatus } = require("../config/roles.cjs");
const { getNode, children, updateNode, log } = require("./tree.cjs");
const { addComment } = require("./comments.cjs");

function chooseOption(tree, oid, rationale, author, rejectSiblings = true) {
  const cfg = treeConfig(tree);
  const option = getNode(tree, oid);
  if (option.type !== "option") throw new DTError(`${oid} is a ${option.type}, not an option`);
  const why = rationale || "";
  if (hasOwn(cfg.fields, "rationale")) updateNode(tree, oid, { status: chosenStatus(cfg), rationale: why || option.rationale || "" }, author);
  else {
    updateNode(tree, oid, { status: chosenStatus(cfg) }, author);
    if (why.trim()) addComment(tree, oid, `Chosen: ${why}`, author);
  }
  const parent = option.parent ? tree.nodes[option.parent] : undefined;
  if (rejectSiblings && parent) {
    for (const sib of children(tree, parent.id)) {
      if (sib.type === "option" && sib.id !== oid && !hasRole(cfg, sib.status, "rejected", "closed")) {
        updateNode(tree, sib.id, { status: rejectedStatus(cfg) }, author);
      }
    }
  }
  if (parent) {
    parent.chosen = oid;
    updateNode(tree, parent.id, { status: decidedStatus(cfg) }, author);
  }
  log(tree, author, "choose", oid, why);
  return option;
}

module.exports = { chooseOption };
