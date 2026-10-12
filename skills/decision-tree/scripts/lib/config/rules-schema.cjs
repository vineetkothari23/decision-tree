"use strict";
/**
 * Shape of node-type `rules` (data only, never evaluated as code):
 *   {when?: <cond>, require: any|all|none|"at-least N"|"at-most N", of: self|{children: 1|"*", type?: id},
 *    where?: <cond>, message?: text, level?: warn|block}
 * A <cond> is a mapping whose keys are ANDed; see CONDITIONS in lib/core/policy/rules.cjs. `filled`/`empty` ignore
 * fields the mode does not define, so a mode that removes an inherited field also drops the rules about it.
 */
const { isPlainObject } = require("../util.cjs");

const RULE_KEYS = ["when", "require", "of", "where", "message", "level"];
const LEVELS = ["warn", "block"];
const COND_KEYS = ["status", "role", "type", "kind", "filled", "empty", "linked", "not"];
const REQUIRE_RE = /^(any|all|none|(at-least|at-most) [0-9]+)$/;

function parseCond(v, where, fail) {
  if (!isPlainObject(v)) fail(where, `must be a mapping with any of: ${COND_KEYS.join(", ")}`);
  for (const [k, x] of Object.entries(v)) {
    if (!COND_KEYS.includes(k)) fail(where, `unknown condition ${JSON.stringify(k)} (allowed: ${COND_KEYS.join(", ")})`);
    if (k === "not") parseCond(x, `${where}.not`, fail);
    else if (k === "linked") {
      if (typeof x !== "boolean") fail(`${where}.linked`, "must be true or false");
    } else if (typeof x !== "string" && !(Array.isArray(x) && x.every((y) => typeof y === "string"))) {
      fail(`${where}.${k}`, "must be an id or a list of ids");
    }
  }
  return v;
}

function parseOf(v, where, fail) {
  if (v === "self") return v;
  if (!isPlainObject(v)) fail(where, 'must be "self" or {children: 1 | "*", type?: id}');
  for (const k of Object.keys(v)) if (!["children", "type"].includes(k)) fail(where, `unknown key ${JSON.stringify(k)} (allowed: children, type)`);
  if (v.children !== 1 && v.children !== "*") fail(`${where}.children`, 'must be 1 (direct children) or "*" (all descendants)');
  if (v.type !== undefined && typeof v.type !== "string") fail(`${where}.type`, "must be a node type id");
  return v;
}

function parseRules(v, where, fail) {
  if (!Array.isArray(v)) fail(where, "must be a list of rules");
  return v.map((r, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(r)) fail(at, `must be a mapping with: ${RULE_KEYS.join(", ")}`);
    for (const k of Object.keys(r)) if (!RULE_KEYS.includes(k)) fail(at, `unknown key ${JSON.stringify(k)} (allowed: ${RULE_KEYS.join(", ")})`);
    const out = { require: r.require ?? "all", of: parseOf(r.of ?? "self", `${at}.of`, fail), level: r.level ?? "warn" };
    if (typeof out.require !== "string" || !REQUIRE_RE.test(out.require)) fail(`${at}.require`, 'must be any, all, none, "at-least N" or "at-most N"');
    if (!LEVELS.includes(out.level)) fail(`${at}.level`, `must be ${LEVELS.join(" or ")}`);
    if (r.when !== undefined) out.when = parseCond(r.when, `${at}.when`, fail);
    if (r.where !== undefined) out.where = parseCond(r.where, `${at}.where`, fail);
    if (r.message !== undefined) {
      if (typeof r.message !== "string") fail(`${at}.message`, "must be a string");
      out.message = r.message;
    }
    return out;
  });
}

/** Cross-check ids used in a finalized config's rules against its statuses, roles, types and fields. */
function checkRules(cfg, roles, where, fail) {
  const types = new Set(["node", "tree", ...Object.keys(cfg.node_types)]);
  const ids = { status: new Set(Object.keys(cfg.statuses)), role: roles, type: types };
  const checkCond = (c, at) => {
    for (const [k, x] of Object.entries(c)) {
      if (k === "not") checkCond(x, `${at}.not`);
      else if (ids[k]) for (const id of [].concat(x)) if (!ids[k].has(id)) fail(`${at}.${k}`, `unknown ${k} ${JSON.stringify(id)}`);
    }
  };
  for (const [tid, t] of Object.entries(cfg.node_types)) {
    (t.rules || []).forEach((r, i) => {
      const at = `${where}.${tid}.rules[${i}]`;
      if (r.of !== "self" && r.of.type && !types.has(r.of.type)) fail(`${at}.of.type`, `unknown node type ${JSON.stringify(r.of.type)}`);
      if (r.when) checkCond(r.when, `${at}.when`);
      if (r.where) checkCond(r.where, `${at}.where`);
    });
  }
}

module.exports = { parseRules, checkRules, LEVELS, COND_KEYS };
