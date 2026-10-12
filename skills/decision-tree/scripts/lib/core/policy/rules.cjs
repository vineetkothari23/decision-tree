"use strict";

/**
 * Node-type rules (see config/rules-schema.cjs): select nodes, count those matching a condition, compare.
 * New condition kinds are one entry in CONDITIONS; new selectors one branch in select().
 */

const { configAt } = require("../../config/scope.cjs");
const { roleOf } = require("../../config/roles.cjs");
const { readField } = require("./fields.cjs");

const list = (x) => [].concat(x);
const isFilled = (n, id) => {
  const v = readField(n, id);
  return Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
};

const definedFields = (tree, n, x) => list(x).filter((id) => id in configAt(tree, n.id).fields);

const CONDITIONS = {
  status: (tree, n, x) => list(x).includes(n.status),
  role: (tree, n, x) => list(x).includes(roleOf(configAt(tree, n.id), n.status)),
  type: (tree, n, x) => list(x).includes(n.type),
  kind: (tree, n, x) => list(x).includes(n.kind),
  filled: (tree, n, x) => definedFields(tree, n, x).every((id) => isFilled(n, id)),
  empty: (tree, n, x) => definedFields(tree, n, x).every((id) => !isFilled(n, id)),
  linked: (tree, n, x) => (n.links || []).length > 0 === x,
  not: (tree, n, x) => !matches(tree, n, x),
};

function matches(tree, n, cond) {
  return !cond || Object.entries(cond).every(([k, x]) => CONDITIONS[k](tree, n, x));
}

const kidsOf = (tree, id) => Object.values(tree.nodes).filter((n) => n.parent === id);

function select(tree, n, of) {
  if (of === "self") return [n];
  let out = kidsOf(tree, n.id);
  if (of.children === "*") {
    for (let i = 0; i < out.length; i++) out.push(...kidsOf(tree, out[i].id));
  }
  return of.type ? out.filter((x) => x.type === of.type) : out;
}

function holds(require, count, total) {
  if (require === "any") return count > 0;
  if (require === "all") return count === total;
  if (require === "none") return count === 0;
  const [op, num] = require.split(" ");
  return op === "at-least" ? count >= Number(num) : count <= Number(num);
}

function describe(rule) {
  const what = rule.of === "self" ? "this node" : `${rule.of.children === 1 ? "children" : "descendants"}${rule.of.type ? ` of type ${rule.of.type}` : ""}`;
  return `rule not met: ${rule.require} of ${what}${rule.where ? ` must match ${JSON.stringify(rule.where)}` : ""}`;
}

/** The rule's message if `n` breaks it (with `status` standing in for n.status when given), else null. */
function breaks(tree, n, rule, status) {
  const self = status === undefined ? n : { ...n, status };
  if (!matches(tree, self, rule.when)) return null;
  const nodes = rule.of === "self" ? [self] : select(tree, n, rule.of);
  const count = nodes.filter((x) => matches(tree, x, rule.where)).length;
  if (holds(rule.require, count, nodes.length)) return null;
  return (rule.message || describe(rule)).replace(/\{count\}/g, String(count));
}

const rulesOf = (cfg, type) => (cfg.node_types && cfg.node_types[type] && cfg.node_types[type].rules) || [];

/** Every broken rule in the tree: [[node id, message, level], ...]. */
function ruleIssues(tree) {
  const out = [];
  for (const n of Object.values(tree.nodes)) {
    for (const rule of rulesOf(configAt(tree, n.id), n.type)) {
      const msg = breaks(tree, n, rule);
      if (msg) out.push([n.id, msg, rule.level]);
    }
  }
  return out;
}

/** Messages of `block` rules that `n` would break with `status`. */
function blockingRules(tree, n, status, cfg = configAt(tree, n.id)) {
  return rulesOf(cfg, n.type).filter((r) => r.level === "block").map((r) => breaks(tree, n, r, status)).filter(Boolean);
}

module.exports = { ruleIssues, blockingRules, CONDITIONS };
