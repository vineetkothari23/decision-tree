"use strict";

/**
 * The opt-in `choose` feature (`features.choose: {type, chosen?, siblings?, parent?}`): the chosen node gets the
 * `chosen` status, its same-type siblings `siblings`, its parent `parent`. Omitted statuses come from status roles.
 */

const { DTError, hasOwn } = require("../util.cjs");
const { configAt } = require("../config/scope.cjs");
const { hasRole, chosenStatus, decidedStatus, rejectedStatus } = require("../config/roles.cjs");
const { getNode, children, updateNode, log } = require("./tree.cjs");
const { addComment } = require("./comments.cjs");

function chooseOption(tree, oid, rationale, author, rejectSiblings = true) {
  const cfg = configAt(tree, oid);
  const option = getNode(tree, oid);
  const feature = cfg.features && cfg.features.choose;
  if (!feature) throw new DTError("this tree's mode has no choose feature (features.choose)");
  if (option.type !== feature.type) throw new DTError(`${oid} is a ${option.type}, not a${/^[aeiou]/.test(feature.type) ? "n" : ""} ${feature.type}`);
  const chosen = feature.chosen || chosenStatus(cfg);
  const why = rationale || "";
  if (hasOwn(cfg.fields, "rationale")) updateNode(tree, oid, { status: chosen, rationale: why || option.rationale || "" }, author);
  else {
    updateNode(tree, oid, { status: chosen }, author);
    if (why.trim()) addComment(tree, oid, `Chosen: ${why}`, author);
  }
  const parent = option.parent ? tree.nodes[option.parent] : undefined;
  if (rejectSiblings && parent) {
    for (const sib of children(tree, parent.id)) {
      if (sib.type === feature.type && sib.id !== oid && !hasRole(cfg, sib.status, "rejected", "closed")) {
        updateNode(tree, sib.id, { status: feature.siblings || rejectedStatus(cfg) }, author);
      }
    }
  }
  if (parent) {
    parent.chosen = oid;
    const pcfg = configAt(tree, parent.id);
    updateNode(tree, parent.id, { status: (pcfg === cfg && feature.parent) || decidedStatus(pcfg) }, author);
  }
  log(tree, author, "choose", oid, why);
  return option;
}

module.exports = { chooseOption };
