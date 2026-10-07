"use strict";

/**
 * Tree data operations: nodes, links and tree metadata, with activity logging.
 * What a node accepts (statuses, kinds, fields, labels, link types) comes from its scope's config via core/policy.
 */

const { NODE_TYPES, TREE_STATUSES, ACTIVITY_LIMIT } = require("../constants.cjs");
const { DTError, now, same, choice, hasOwn, isPlainObject } = require("../util.cjs");
const { configAt, configUnder } = require("../config/scope.cjs");
const { initialStatus } = require("../config/roles.cjs");
const { checkStatus, checkKind, linkType } = require("./policy/vocab.cjs");
const { isEmptyValue, fieldValue, readField, writeField, fieldPath } = require("./policy/fields.cjs");
const { labelsValue } = require("./policy/labels.cjs");
const { lockValue, assertUnlocked } = require("./policy/locks.cjs");

/** Node keys `updateNode` edits directly; any configured field id is editable too (or via `fields: {id: value}`). */
const NODE_KEYS = ["title", "kind", "status", "type", "labels"];

function log(tree, author, action, nodeId, detail = "") {
  if (!tree.activity) tree.activity = [];
  tree.activity.push({ at: now(), by: author, action, node: nodeId, detail });
  if (tree.activity.length > ACTIVITY_LIMIT) tree.activity.splice(0, tree.activity.length - ACTIVITY_LIMIT);
}

function getNode(tree, nid) {
  const node = hasOwn(tree.nodes, nid) ? tree.nodes[nid] : undefined;
  if (!node) throw new DTError(`node ${JSON.stringify(nid)} not found in tree ${JSON.stringify(tree.id)}`);
  return node;
}

const children = (tree, nid) => Object.values(tree.nodes).filter((n) => n.parent === nid);

function descendants(tree, nid) {
  const out = [];
  const stack = [nid];
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    for (const c of children(tree, cur)) stack.push(c.id);
  }
  return out;
}

/** `{id: value}` for every field given a non-empty value, checked against `cfg`. */
function fieldValues(cfg, values) {
  const out = {};
  for (const [id, v] of Object.entries(values)) if (!isEmptyValue(v)) out[id] = fieldValue(cfg, id, v);
  return out;
}

function addNode(tree, { parent, type = "question", title, body = "", kind = null, status = null, author = null,
  pros = null, cons = null, assignee = "", rationale = "", fields = {}, labels = null, lock = null }) {
  const cfg = configUnder(tree, parent);
  choice(type, Object.keys(NODE_TYPES), "node type");
  const st = checkStatus(cfg, status || initialStatus(cfg));
  const k = type === "question" ? checkKind(cfg, kind) : null;
  if (parent !== null && parent !== undefined) {
    getNode(tree, parent);
    assertUnlocked(tree, parent, "add a node here");
  } else if (Object.keys(tree.nodes).length) {
    throw new DTError("a parent node id is required (only the root goal has no parent)");
  }
  if (!title || !String(title).trim()) throw new DTError("title is required");
  if (!isPlainObject(fields)) throw new DTError("fields must be a mapping of field id to value");
  const values = fieldValues(cfg, { body, pros, cons, rationale, assignee, ...fields });
  const nodeLabels = labelsValue(cfg, labels);
  const nodeLock = lockValue(lock);
  const nid = `${NODE_TYPES[type]}${tree.next_id}`;
  tree.next_id += 1;
  const ts = now();
  const node = {
    id: nid,
    type,
    kind: k,
    title: String(title).trim(),
    body: "",
    status: st,
    parent: parent ?? null,
    pros: [],
    cons: [],
    rationale: "",
    assignee: "",
    chosen: null,
    links: [],
    comments: [],
    history: [],
    created_by: author,
    created_at: ts,
    updated_at: ts,
  };
  for (const [id, v] of Object.entries(values)) writeField(node, id, v);
  if (nodeLabels.length) node.labels = nodeLabels;
  if (nodeLock) node.lock = nodeLock;
  tree.nodes[nid] = node;
  log(tree, author, "add", nid, `${type}: ${node.title}`);
  return node;
}

function updateNode(tree, nid, changes, author) {
  const node = getNode(tree, nid);
  const cfg = configAt(tree, nid);
  const updates = [];
  for (const [key, raw] of Object.entries(changes)) {
    if (raw === undefined || raw === null) continue;
    if (key === "fields") {
      if (!isPlainObject(raw)) throw new DTError("fields must be a mapping of field id to value");
      for (const [id, v] of Object.entries(raw)) if (v !== undefined && v !== null) updates.push([fieldPath(id), id, fieldValue(cfg, id, v)]);
    } else if (NODE_KEYS.includes(key)) {
      let value = raw;
      if (key === "status") checkStatus(cfg, value);
      else if (key === "kind") value = checkKind(cfg, value || null);
      else if (key === "type") choice(value, Object.keys(NODE_TYPES), "node type");
      else if (key === "labels") value = labelsValue(cfg, value);
      else if (key === "title" && !String(value).trim()) throw new DTError("title cannot be empty");
      updates.push([key, null, value]);
    } else if (hasOwn(cfg.fields, key)) {
      updates.push([fieldPath(key), key, fieldValue(cfg, key, raw)]);
    } else {
      throw new DTError(`field ${JSON.stringify(key)} is not editable` +
        ` (editable: ${[...NODE_KEYS, ...Object.keys(cfg.fields)].join(", ")})`);
    }
  }
  const changed = [];
  for (const [label, fieldId, value] of updates) {
    const before = fieldId ? readField(node, fieldId) : key0(node, label);
    if (same(before, value) || (isEmptyValue(before) && isEmptyValue(value))) continue;
    node.history.push({ at: now(), by: author, field: label, from: before ?? null, to: value });
    if (fieldId) writeField(node, fieldId, value);
    else if (label === "labels" && !value.length) delete node.labels;
    else node[label] = value;
    changed.push(label);
  }
  if (changed.length) {
    node.updated_at = now();
    const detail = changed.map((k) => (["status", "kind", "type"].includes(k) ? `${k}=${node[k]}` : k)).join(", ");
    log(tree, author, "update", nid, detail);
  }
  return node;
}

const key0 = (node, key) => (key === "labels" ? node.labels || [] : node[key]);

/** Sets (`children`/`subtree`) or clears (null) a node's structural lock. */
function lockNode(tree, nid, lock, author) {
  const node = getNode(tree, nid);
  const value = lockValue(lock);
  if ((node.lock || null) === value) return node;
  node.history.push({ at: now(), by: author, field: "lock", from: node.lock || null, to: value });
  if (value) node.lock = value;
  else delete node.lock;
  node.updated_at = now();
  log(tree, author, value ? "lock" : "unlock", nid, value || "");
  return node;
}

function moveNode(tree, nid, newParent, author) {
  const node = getNode(tree, nid);
  getNode(tree, newParent);
  if (nid === tree.root_id) throw new DTError("cannot move the root goal");
  if (descendants(tree, nid).includes(newParent)) throw new DTError("cannot move a node under its own descendant");
  if (node.parent === newParent) return node;
  assertUnlocked(tree, node.parent, `move ${nid}`);
  assertUnlocked(tree, newParent, `move ${nid} under ${newParent}`);
  node.parent = newParent;
  node.updated_at = now();
  log(tree, author, "move", nid, `under ${newParent}`);
  return node;
}

function deleteNode(tree, nid, author) {
  const node = getNode(tree, nid);
  if (nid === tree.root_id) throw new DTError("cannot delete the root goal; delete the tree file instead");
  assertUnlocked(tree, node.parent, `delete ${nid}`);
  const removed = new Set(descendants(tree, nid));
  for (const rid of removed) delete tree.nodes[rid];
  for (const n of Object.values(tree.nodes)) {
    n.links = n.links.filter((lk) => !removed.has(lk.target));
    if (removed.has(n.chosen)) n.chosen = null;
  }
  log(tree, author, "delete", nid, `${removed.size} node(s)`);
  return [...removed].sort();
}

/** Links `src` to `dst`; `type` defaults to the first link type of `src`'s scope. */
function addLink(tree, src, dst, type, author) {
  const node = getNode(tree, src);
  getNode(tree, dst);
  const t = linkType(configAt(tree, src), type);
  if (src === dst) throw new DTError("cannot link a node to itself");
  const link = { target: dst, type: t };
  if (!node.links.some((lk) => same(lk, link))) {
    node.links.push(link);
    log(tree, author, "link", src, `${t} ${dst}`);
  }
  return link;
}

function removeLink(tree, src, dst, type, author) {
  const node = getNode(tree, src);
  const before = node.links.length;
  node.links = node.links.filter((lk) => !(lk.target === dst && (!type || lk.type === type)));
  if (node.links.length !== before) log(tree, author, "unlink", src, dst);
}

function updateTreeMeta(tree, fields, author) {
  for (const key of ["title", "description", "status"]) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (key === "status") choice(value, TREE_STATUSES, "tree status");
    tree[key] = value;
    if (key !== "status" && tree.nodes[tree.root_id]) tree.nodes[tree.root_id][key === "title" ? "title" : "body"] = value;
    log(tree, author, "tree", null, key === "status" ? `${key}=${value}` : key);
  }
  return tree;
}

module.exports = {
  NODE_KEYS, log, getNode, children, descendants, addNode, updateNode, lockNode, moveNode, deleteNode, addLink, removeLink, updateTreeMeta,
};
