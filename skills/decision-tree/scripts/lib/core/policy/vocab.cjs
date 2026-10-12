"use strict";

/** The tree's own vocabularies: which statuses, question kinds and link types it accepts. */

const { DTError, choice } = require("../../util.cjs");
const { NODE_TYPES } = require("../../constants.cjs");

const checkStatus = (cfg, status) => choice(status, Object.keys(cfg.statuses), "status");

const nodeTypesOf = (cfg) => cfg.node_types || {};

function kindsFor(cfg, type) {
  return Object.prototype.hasOwnProperty.call(NODE_TYPES, type)
    ? cfg.kinds
    : nodeTypesOf(cfg)[type]?.kinds || [];
}

function checkKind(cfg, kind, type = "question") {
  if (!kind) return null;
  const kinds = kindsFor(cfg, type);
  if (!kinds.length) {
    throw new DTError(type === "question"
      ? "this tree's mode defines no question kinds"
      : `node type ${JSON.stringify(type)} defines no kinds`);
  }
  return choice(kind, kinds, "kind");
}

/** The given link type, or the mode's first one when omitted. */
function linkType(cfg, type) {
  const types = Object.keys(cfg.link_types);
  if (!types.length) throw new DTError("this tree's mode defines no link types");
  return type ? choice(type, types, "link type") : types[0];
}

module.exports = { checkStatus, checkKind, kindsFor, nodeTypesOf, linkType };
