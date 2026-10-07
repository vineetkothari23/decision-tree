"use strict";

/** Whether a node's existing values (status, kind, labels, fields, link types) fit a config. */

const { hasOwn } = require("../../util.cjs");

const BUILTIN_VALUES = ["body", "pros", "cons", "rationale", "assignee"];

/** Problems that would make `n` invalid under `cfg`, as short phrases ("q3 has status \"x\""). */
function nodeConflicts(n, cfg) {
  const out = [];
  if (!hasOwn(cfg.statuses, n.status)) out.push(`${n.id} has status ${JSON.stringify(n.status)}`);
  if (n.kind && !cfg.kinds.includes(n.kind)) out.push(`${n.id} has kind ${JSON.stringify(n.kind)}`);
  for (const l of n.labels || []) if (!cfg.labels.includes(l)) out.push(`${n.id} has label ${JSON.stringify(l)}`);
  for (const f of BUILTIN_VALUES) {
    if (n[f] && n[f].length && !hasOwn(cfg.fields, f)) out.push(`${n.id} uses field ${JSON.stringify(f)}`);
  }
  for (const [f, v] of Object.entries(n.fields || {})) {
    if (!hasOwn(cfg.fields, f)) out.push(`${n.id} uses field ${JSON.stringify(f)}`);
    else if ((cfg.fields[f].type === "list") !== Array.isArray(v)) out.push(`${n.id} has a ${Array.isArray(v) ? "list" : "text"} value for ${JSON.stringify(f)}`);
  }
  for (const lk of n.links || []) if (!hasOwn(cfg.link_types, lk.type)) out.push(`${n.id} has a ${JSON.stringify(lk.type)} link`);
  return out;
}

/** A short "a; b; c (+N more)" summary of conflicts. */
const summarizeConflicts = (bad) => `${bad.slice(0, 5).join("; ")}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ""}`;

module.exports = { nodeConflicts, summarizeConflicts };
