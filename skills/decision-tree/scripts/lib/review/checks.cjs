"use strict";

/** Rigor checks that `dtree review` reports. */

const { children } = require("../core/tree.cjs");
const { inbox } = require("./inbox.cjs");

/** Gaps an agent should address to make the tree rigorous. */
function review(tree) {
  const issues = [];
  const nodes = Object.values(tree.nodes);
  const root = tree.nodes[tree.root_id];
  if (root) {
    const kinds = new Set(nodes.filter((n) => n.type === "question").map((n) => n.kind));
    const missing = ["why", "what", "how", "where"].filter((k) => !kinds.has(k));
    if (missing.length) issues.push([root.id, `no ${missing.join("/")} questions asked yet`]);
  }
  for (const n of nodes) {
    const kids = children(tree, n.id);
    const opts = kids.filter((k) => k.type === "option");
    if (n.type === "question") {
      if (!["decided", "deferred", "done", "rejected"].includes(n.status) && opts.length < 2) {
        issues.push([n.id, `open question has ${opts.length} option(s); propose at least 2`]);
      }
      if (n.status === "decided" && !n.chosen && !opts.some((o) => o.status === "chosen")) {
        issues.push([n.id, "marked decided but no option is chosen"]);
      }
    }
    if (n.type === "option" && !["rejected", "deferred"].includes(n.status)) {
      if (!n.pros.length || !n.cons.length) issues.push([n.id, "option lacks pros and/or cons"]);
      if (n.status === "chosen" && !n.rationale) issues.push([n.id, "chosen option has no rationale"]);
      if (n.status === "chosen" && !kids.some((k) => k.type === "question")) {
        issues.push([n.id, "chosen option has no follow-up questions (how/where/what next?)"]);
      }
    }
    if (n.type === "question" && n.status === "blocked" && !n.links.length) {
      issues.push([n.id, "blocked but no depends-on/blocks link explains why"]);
    }
  }
  for (const item of inbox(tree, "agent")) {
    issues.push([item.node, `unanswered human comment ${item.thread}: ${item.last.text.slice(0, 80)}`]);
  }
  return issues;
}

module.exports = { review };
