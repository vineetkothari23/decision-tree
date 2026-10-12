"use strict";

/** Rigor checks that `dtree review` reports: required kinds per scope, node-type rules, unanswered comments. */

const { isScope, configUnder, scopeRoot } = require("../config/scope.cjs");
const { ruleIssues } = require("../core/policy/rules.cjs");
const { inbox } = require("./inbox.cjs");

/** Gaps an agent should address to make the tree rigorous. */
function review(tree) {
  const issues = [];
  const nodes = Object.values(tree.nodes);
  for (const scope of [tree.nodes[tree.root_id], ...nodes.filter(isScope)].filter(Boolean)) {
    const required = configUnder(tree, scope.id).review.required_kinds;
    const asked = nodes.filter((n) => n.kind && scopeRoot(tree, n.id) === scope.id);
    const kinds = new Set(asked.map((n) => n.kind));
    const missing = required.filter((k) => !kinds.has(k));
    if (missing.length) issues.push([scope.id, `no ${missing.join("/")} questions asked yet`]);
  }
  for (const [id, msg] of ruleIssues(tree)) issues.push([id, msg]);
  for (const item of inbox(tree, "agent")) {
    issues.push([item.node, `unanswered human comment ${item.thread}: ${item.last.text.slice(0, 80)}`]);
  }
  return issues;
}

module.exports = { review };
