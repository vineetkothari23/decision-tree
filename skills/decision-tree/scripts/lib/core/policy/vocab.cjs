"use strict";

/** The tree's own vocabularies: which node types, statuses, kinds and link types it accepts. */

const { DTError, choice, hasOwn } = require("../../util.cjs");
const { NODE_TYPES } = require("../../constants.cjs");

const checkStatus = (cfg, status) => choice(status, Object.keys(cfg.statuses), "status");

const nodeTypesOf = (cfg) => cfg.node_types || {};
const typeIds = (cfg) => [...Object.keys(NODE_TYPES), ...Object.keys(nodeTypesOf(cfg))];
const isKnownType = (cfg, type) => hasOwn(NODE_TYPES, type) || hasOwn(nodeTypesOf(cfg), type);
const checkType = (cfg, type) => choice(type, typeIds(cfg), "node type");
const findType = (cfg, flag) => Object.keys(nodeTypesOf(cfg)).find((id) => nodeTypesOf(cfg)[id][flag]);
/** The type `add` uses without -t: the one marked `default: true`, else the generic node. */
const defaultType = (cfg) => findType(cfg, "default") || "node";
/** The type of a new tree's root: the one marked `root: true`, else the generic node. */
const rootType = (cfg) => findType(cfg, "root") || "node";
const prefixOf = (cfg, type) => nodeTypesOf(cfg)[type]?.prefix || NODE_TYPES[type];

/** A type's own kinds; the default type falls back to the mode-wide `kinds`. */
function kindsFor(cfg, type) {
  const own = nodeTypesOf(cfg)[type]?.kinds || [];
  if (own.length) return own;
  return type === defaultType(cfg) ? cfg.kinds || [] : [];
}

function checkKind(cfg, kind, type = defaultType(cfg)) {
  if (!kind) return null;
  const kinds = kindsFor(cfg, type);
  if (!kinds.length) throw new DTError(`node type ${JSON.stringify(type)} defines no kinds`);
  return choice(kind, kinds, "kind");
}

/** Statuses a type may use: its own `statuses` list, else all of the mode's. */
const statusesFor = (cfg, type) => nodeTypesOf(cfg)[type]?.statuses || Object.keys(cfg.statuses);
/** Fields a type may use: its own `fields` list, else all of the mode's. */
const fieldsFor = (cfg, type) => nodeTypesOf(cfg)[type]?.fields || Object.keys(cfg.fields);

function checkTypeStatus(cfg, status, type) {
  checkStatus(cfg, status);
  const allowed = statusesFor(cfg, type);
  if (!allowed.includes(status)) throw new DTError(`status ${JSON.stringify(status)} is not allowed on ${type} (allowed: ${allowed.join(", ")})`);
  return status;
}

/** The status new nodes of `type` get: the first allowed status with role open. */
const initialStatusFor = (cfg, type) => statusesFor(cfg, type).find((s) => cfg.statuses[s].role === "open");

function checkTypeField(cfg, id, type) {
  if (id !== "body" && hasOwn(cfg.fields, id) && !fieldsFor(cfg, type).includes(id)) {
    throw new DTError(`field ${JSON.stringify(id)} is not allowed on ${type} (allowed: ${fieldsFor(cfg, type).join(", ")})`);
  }
}

/** The given link type, or the mode's first one when omitted. */
function linkType(cfg, type) {
  const types = Object.keys(cfg.link_types);
  if (!types.length) throw new DTError("this tree's mode defines no link types");
  return type ? choice(type, types, "link type") : types[0];
}

module.exports = {
  checkStatus, checkKind, kindsFor, nodeTypesOf, linkType, typeIds, isKnownType, checkType, defaultType, rootType, prefixOf,
  statusesFor, fieldsFor, checkTypeStatus, initialStatusFor, checkTypeField,
};
