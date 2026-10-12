"use strict";

/**
 * Backward compatibility in one place: the decision-tree vocabulary that 0.4.x and earlier built in, applied to
 * trees without config (LEGACY_CONFIG) and to configs saved before modes declared node types and features.
 * Keep DECISION_TREE in sync with templates/decision-tree.yaml (a test checks this).
 */

const { hasOwn } = require("../util.cjs");

const OPEN = { not: { role: ["accepted", "rejected", "closed"] } };

function decisionTreeTypes({ weighs = true, explains = true } = {}) {
  const option = [];
  if (weighs) option.push({ when: { not: { role: ["rejected", "closed"] } }, require: "all", of: "self", where: { filled: ["pros", "cons"] }, level: "warn", message: "option lacks pros and/or cons" });
  if (explains) option.push({ when: { role: "accepted" }, require: "all", of: "self", where: { filled: "rationale" }, level: "warn", message: "chosen option has no rationale" });
  option.push({ when: { role: "accepted" }, require: "any", of: { children: 1, type: "question" }, level: "warn", message: "chosen option has no follow-up questions (how/where/what next?)" });
  return {
    goal: { name: "Goal", prefix: "g", color: "#7c3aed", root: true, kinds: [] },
    question: {
      name: "Question", prefix: "q", color: "#2563eb", default: true, kinds: [], rules: [
        { when: OPEN, require: "at-least 2", of: { children: 1, type: "option" }, level: "warn", message: "open question has {count} option(s); propose at least 2" },
        { when: { role: "accepted" }, require: "any", of: { children: 1, type: "option" }, where: { role: "accepted" }, level: "warn", message: "marked decided but no option is chosen" },
        { when: { role: "blocked" }, require: "all", of: "self", where: { linked: true }, level: "warn", message: "blocked but no link explains why" },
      ],
    },
    option: { name: "Option", prefix: "o", color: "#d97706", kinds: [], rules: option },
    decision: { name: "Decision", prefix: "d", color: "#059669", kinds: [] },
    task: { name: "Task", prefix: "t", color: "#0891b2", kinds: [] },
    note: { name: "Note", prefix: "n", color: "#64748b", kinds: [] },
  };
}

const DECISION_TREE_FEATURES = { assignee: true, choose: { type: "option" } };

/** A config saved by 0.4.x (no `features`): add the decision-tree types, features and rules it relied on. */
function upgradeConfig(cfg) {
  if (!cfg || hasOwn(cfg, "features")) return cfg;
  const fields = cfg.fields || {};
  const types = decisionTreeTypes({ weighs: hasOwn(fields, "pros") && hasOwn(fields, "cons"), explains: hasOwn(fields, "rationale") });
  cfg.node_types = { ...types, ...(cfg.node_types || {}) };
  cfg.features = { assignee: hasOwn(fields, "assignee"), choose: { type: "option" } };
  return cfg;
}

/** Upgrade a loaded tree's own config and its sub-tree configs in place. */
function upgradeTree(tree) {
  if (tree && tree.config) upgradeConfig(tree.config);
  for (const n of Object.values((tree && tree.nodes) || {})) if (n.type === "tree" && n.config) upgradeConfig(n.config);
  return tree;
}

/** Old mode names that resolve to a built-in mode. */
const MODE_ALIASES = { default: "decision-tree" };

module.exports = { decisionTreeTypes, DECISION_TREE_FEATURES, upgradeConfig, upgradeTree, MODE_ALIASES };
