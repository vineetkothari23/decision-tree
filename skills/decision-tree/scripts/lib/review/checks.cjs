"use strict";

/** Rigor checks that `dtree review` reports, driven by each node's scope config (status roles, fields, required kinds). */

const { hasOwn } = require("../util.cjs");
const { children } = require("../core/tree.cjs");
const { configAt } = require("../config/scope.cjs");
const { hasRole, isDone, chosenStatus } = require("../config/roles.cjs");
const { inbox } = require("./inbox.cjs");

/** Gaps an agent should address to make the tree rigorous. */
function review(tree) {
  const issues = [];
  const nodes = Object.values(tree.nodes);
  const root = tree.nodes[tree.root_id];
  const required = root ? configAt(tree, root.id).review.required_kinds : [];
  if (root && required.length) {
    const kinds = new Set(nodes.filter((n) => n.type === "question").map((n) => n.kind));
    const missing = required.filter((k) => !kinds.has(k));
    if (missing.length) issues.push([root.id, `no ${missing.join("/")} questions asked yet`]);
  }
  for (const n of nodes) {
    const cfg = configAt(tree, n.id);
    const weighs = hasOwn(cfg.fields, "pros") && hasOwn(cfg.fields, "cons");
    const explains = hasOwn(cfg.fields, "rationale");
    const chosen = chosenStatus(cfg);
    const kids = children(tree, n.id);
    const opts = kids.filter((k) => k.type === "option");
    if (n.type === "question") {
      if (!isDone(cfg, n.status) && opts.length < 2) {
        issues.push([n.id, `open question has ${opts.length} option(s); propose at least 2`]);
      }
      if (hasRole(cfg, n.status, "accepted") && !n.chosen && !opts.some((o) => hasRole(cfg, o.status, "accepted"))) {
        issues.push([n.id, "marked decided but no option is chosen"]);
      }
      if (hasRole(cfg, n.status, "blocked") && !n.links.length) {
        issues.push([n.id, "blocked but no link explains why"]);
      }
    }
    if (n.type === "option" && !hasRole(cfg, n.status, "rejected", "closed")) {
      if (weighs && (!n.pros.length || !n.cons.length)) issues.push([n.id, "option lacks pros and/or cons"]);
      if (n.status === chosen && explains && !n.rationale) issues.push([n.id, "chosen option has no rationale"]);
      if (n.status === chosen && !kids.some((k) => k.type === "question")) {
        issues.push([n.id, "chosen option has no follow-up questions (how/where/what next?)"]);
      }
    }
  }
  for (const item of inbox(tree, "agent")) {
    issues.push([item.node, `unanswered human comment ${item.thread}: ${item.last.text.slice(0, 80)}`]);
  }
  return issues;
}

module.exports = { review };
