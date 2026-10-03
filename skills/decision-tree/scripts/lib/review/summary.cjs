"use strict";

/** Per-tree counts for listings. */

const { CLOSED_STATUSES } = require("../constants.cjs");
const { threads } = require("../core/comments.cjs");
const { inbox } = require("./inbox.cjs");

function summarize(tree) {
  const nodes = Object.values(tree.nodes);
  const byStatus = {};
  for (const n of nodes) byStatus[n.status] = (byStatus[n.status] || 0) + 1;
  const openQ = nodes.filter((n) => n.type === "question" && !CLOSED_STATUSES.has(n.status)).length;
  const unresolved = nodes.reduce((acc, n) => acc + threads(n).filter((t) => !t[0].resolved).length, 0);
  return {
    id: tree.id,
    title: tree.title ?? tree.id,
    status: tree.status ?? "draft",
    template: tree.template ?? null,
    revision: tree.revision ?? 0,
    updated_at: tree.updated_at ?? null,
    node_count: nodes.length,
    open_questions: openQ,
    needs_input: byStatus["needs-input"] || 0,
    unresolved_threads: unresolved,
    by_status: byStatus,
    waiting_on_agent: inbox(tree, "agent").length,
    waiting_on_human: inbox(tree, "human").length,
  };
}

module.exports = { summarize };
