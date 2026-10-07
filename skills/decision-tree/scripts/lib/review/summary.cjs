"use strict";

/** Per-tree counts for listings. */

const { threads } = require("../core/comments.cjs");
const { configAt } = require("../config/scope.cjs");
const { hasRole, isDone } = require("../config/roles.cjs");
const { inbox } = require("./inbox.cjs");

function summarize(tree) {
  const nodes = Object.values(tree.nodes);
  const byStatus = {};
  for (const n of nodes) byStatus[n.status] = (byStatus[n.status] || 0) + 1;
  const openQ = nodes.filter((n) => n.type === "question" && !isDone(configAt(tree, n.id), n.status)).length;
  const unresolved = nodes.reduce((acc, n) => acc + threads(n).filter((t) => !t[0].resolved).length, 0);
  return {
    id: tree.id,
    title: tree.title ?? tree.id,
    status: tree.status ?? "draft",
    template: tree.template ?? null,
    mode: tree.config ? tree.template ?? null : null,
    revision: tree.revision ?? 0,
    updated_at: tree.updated_at ?? null,
    node_count: nodes.length,
    open_questions: openQ,
    needs_input: nodes.filter((n) => hasRole(configAt(tree, n.id), n.status, "waiting")).length,
    unresolved_threads: unresolved,
    by_status: byStatus,
    waiting_on_agent: inbox(tree, "agent").length,
    waiting_on_human: inbox(tree, "human").length,
  };
}

module.exports = { summarize };
