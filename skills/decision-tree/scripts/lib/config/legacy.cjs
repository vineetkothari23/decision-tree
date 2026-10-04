"use strict";

/** The config of trees created before modes existed: every built-in field, status and link type. */

const { KINDS, STATUSES, LINK_TYPES } = require("../constants.cjs");

const LEGACY_ROLES = {
  open: "open", exploring: "open", "needs-input": "waiting", blocked: "blocked",
  decided: "accepted", chosen: "accepted", rejected: "rejected", deferred: "closed", done: "closed",
};

function deepFreeze(v) {
  if (v && typeof v === "object") for (const x of Object.values(Object.freeze(v))) deepFreeze(x);
  return v;
}

const LEGACY_CONFIG = deepFreeze({
  fields: {
    body: { name: "Details", type: "text_body" },
    pros: { name: "Pros", type: "list" },
    cons: { name: "Cons", type: "list" },
    rationale: { name: "Rationale / answer", type: "text_body" },
    assignee: { name: "Assignee", type: "text" },
  },
  link_types: Object.fromEntries(LINK_TYPES.map((t) => [t, { name: t }])),
  statuses: Object.fromEntries(STATUSES.map((s) => [s, { name: s, role: LEGACY_ROLES[s] }])),
  comments: { threads: true },
  review: { required_kinds: ["why", "what", "how", "where"] },
  kinds: [...KINDS],
  labels: [],
});

/** A tree's config: its own resolved mode config, or the legacy one for trees without `config`. */
const treeConfig = (tree) => tree.config || LEGACY_CONFIG;

module.exports = { LEGACY_CONFIG, treeConfig };
