"use strict";

/** The tree's own vocabularies: which statuses, question kinds and link types it accepts. */

const { DTError, choice } = require("../../util.cjs");

const checkStatus = (cfg, status) => choice(status, Object.keys(cfg.statuses), "status");

function checkKind(cfg, kind) {
  if (!kind) return null;
  if (!cfg.kinds.length) throw new DTError("this tree's mode defines no question kinds");
  return choice(kind, cfg.kinds, "kind");
}

/** The given link type, or the mode's first one when omitted. */
function linkType(cfg, type) {
  const types = Object.keys(cfg.link_types);
  if (!types.length) throw new DTError("this tree's mode defines no link types");
  return type ? choice(type, types, "link type") : types[0];
}

module.exports = { checkStatus, checkKind, linkType };
