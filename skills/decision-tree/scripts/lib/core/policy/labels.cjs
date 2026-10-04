"use strict";

/** Node labels, limited to the ones the tree's mode lists. */

const { DTError, asList } = require("../../util.cjs");

function labelsValue(cfg, value) {
  const labels = [...new Set(asList(value))];
  const unknown = labels.filter((l) => !cfg.labels.includes(l));
  if (unknown.length) {
    throw new DTError(cfg.labels.length
      ? `unknown label(s) ${unknown.join(", ")}; this tree's labels are: ${cfg.labels.join(", ")}`
      : "this tree's mode defines no labels");
  }
  return labels;
}

module.exports = { labelsValue };
