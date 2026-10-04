"use strict";

/**
 * Configured text fields. Built-in ids (body, pros, cons, rationale, assignee) live directly on the node;
 * any other id lives under `node.fields`.
 */

const { DTError, hasOwn, asList } = require("../../util.cjs");
const { BUILTIN_FIELDS } = require("../../config/sections.cjs");

const isBuiltinField = (id) => hasOwn(BUILTIN_FIELDS, id);
const isEmptyValue = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

function fieldDef(cfg, id) {
  if (!hasOwn(cfg.fields, id)) {
    const known = Object.keys(cfg.fields);
    throw new DTError(`field ${JSON.stringify(id)} is not part of this tree's mode (fields: ${known.join(", ") || "none"})`);
  }
  return cfg.fields[id];
}

/** `value` checked against the field's definition and coerced to its type. */
function fieldValue(cfg, id, value) {
  const def = fieldDef(cfg, id);
  if (def.type === "list") return asList(value);
  if (typeof value !== "string" && typeof value !== "number") throw new DTError(`field ${JSON.stringify(id)} must be text`);
  return def.type === "text" ? String(value).trim() : String(value);
}

const readField = (node, id) => (isBuiltinField(id) ? node[id] : (node.fields || {})[id]);
const fieldPath = (id) => (isBuiltinField(id) ? id : `fields.${id}`);

function writeField(node, id, value) {
  if (isBuiltinField(id)) node[id] = value;
  else if (isEmptyValue(value)) {
    if (node.fields) delete node.fields[id];
  } else node.fields = { ...(node.fields || {}), [id]: value };
}

module.exports = { isBuiltinField, isEmptyValue, fieldDef, fieldValue, readField, writeField, fieldPath };
