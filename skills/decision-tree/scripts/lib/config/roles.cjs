"use strict";

/**
 * Status roles: node status names come from a tree's config, but what a status *means* to choose, review,
 * inbox and counts is one of these fixed roles.
 */

const { hasOwn } = require("../util.cjs");

const ROLES = ["open", "accepted", "rejected", "waiting", "blocked", "closed"];
const REQUIRED_ROLES = ["open", "accepted", "rejected"];
const DONE_ROLES = new Set(["accepted", "rejected", "closed"]);

const roleOf = (cfg, status) => (hasOwn(cfg.statuses, status) ? cfg.statuses[status].role : null);
const statusesWithRole = (cfg, role) => Object.keys(cfg.statuses).filter((s) => cfg.statuses[s].role === role);
const hasRole = (cfg, status, ...roles) => roles.includes(roleOf(cfg, status));
/** Accepted, rejected or closed: nothing left to decide. */
const isDone = (cfg, status) => DONE_ROLES.has(roleOf(cfg, status));
/** The status new nodes get: the first `open` one. */
const initialStatus = (cfg) => statusesWithRole(cfg, "open")[0];
/** Choosing marks the option with the last `accepted` status and its question with the first. */
const chosenStatus = (cfg) => statusesWithRole(cfg, "accepted").slice(-1)[0];
const decidedStatus = (cfg) => statusesWithRole(cfg, "accepted")[0];
const rejectedStatus = (cfg) => statusesWithRole(cfg, "rejected")[0];
const waitingStatus = (cfg) => statusesWithRole(cfg, "waiting")[0] || null;

module.exports = {
  ROLES, REQUIRED_ROLES, roleOf, statusesWithRole, hasRole, isDone, initialStatus, chosenStatus, decidedStatus, rejectedStatus, waitingStatus,
};
