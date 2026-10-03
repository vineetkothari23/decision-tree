"use strict";

/** Tree data operations: nodes, links and tree metadata, with activity logging. */

const { NODE_TYPES, KINDS, STATUSES, TREE_STATUSES, LINK_TYPES, EDITABLE_NODE_FIELDS, ACTIVITY_LIMIT } = require("../constants.cjs");
const { DTError, now, same, choice, asList } = require("../util.cjs");

function log(tree, author, action, nodeId, detail = "") {
  if (!tree.activity) tree.activity = [];
  tree.activity.push({ at: now(), by: author, action, node: nodeId, detail });
  if (tree.activity.length > ACTIVITY_LIMIT) tree.activity.splice(0, tree.activity.length - ACTIVITY_LIMIT);
}

function getNode(tree, nid) {
  const node = Object.prototype.hasOwnProperty.call(tree.nodes, nid) ? tree.nodes[nid] : undefined;
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

function addNode(tree, { parent, type = "question", title, body = "", kind = null, status = "open", author = null,
  pros = null, cons = null, assignee = "" }) {
  choice(type, Object.keys(NODE_TYPES), "node type");
  choice(status, STATUSES, "status");
  if (kind) choice(kind, KINDS, "kind");
  if (parent !== null && parent !== undefined) getNode(tree, parent);
  else if (Object.keys(tree.nodes).length) {
    throw new DTError("a parent node id is required (only the root goal has no parent)");
  }
  if (!title || !String(title).trim()) throw new DTError("title is required");
  const nid = `${NODE_TYPES[type]}${tree.next_id}`;
  tree.next_id += 1;
  const ts = now();
  const node = {
    id: nid,
    type,
    kind: type === "question" ? kind || null : null,
    title: String(title).trim(),
    body: body || "",
    status,
    parent: parent ?? null,
    pros: asList(pros),
    cons: asList(cons),
    rationale: "",
    assignee: assignee || "",
    chosen: null,
    links: [],
    comments: [],
    history: [],
    created_by: author,
    created_at: ts,
    updated_at: ts,
  };
  tree.nodes[nid] = node;
  log(tree, author, "add", nid, `${type}: ${node.title}`);
  return node;
}

function updateNode(tree, nid, fields, author) {
  const node = getNode(tree, nid);
  const changed = [];
  for (let [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (!EDITABLE_NODE_FIELDS.includes(key)) throw new DTError(`field ${JSON.stringify(key)} is not editable`);
    if (key === "status") choice(value, STATUSES, "status");
    else if (key === "kind") {
      value = value || null;
      if (value) choice(value, KINDS, "kind");
    } else if (key === "type") choice(value, Object.keys(NODE_TYPES), "node type");
    else if (key === "pros" || key === "cons") value = asList(value);
    else if (key === "title" && !String(value).trim()) throw new DTError("title cannot be empty");
    if (!same(node[key], value)) {
      node.history.push({ at: now(), by: author, field: key, from: node[key] ?? null, to: value });
      node[key] = value;
      changed.push(key);
    }
  }
  if (changed.length) {
    node.updated_at = now();
    const detail = changed.map((k) => (["status", "kind", "type"].includes(k) ? `${k}=${node[k]}` : k)).join(", ");
    log(tree, author, "update", nid, detail);
  }
  return node;
}

function moveNode(tree, nid, newParent, author) {
  const node = getNode(tree, nid);
  getNode(tree, newParent);
  if (nid === tree.root_id) throw new DTError("cannot move the root goal");
  if (descendants(tree, nid).includes(newParent)) throw new DTError("cannot move a node under its own descendant");
  node.parent = newParent;
  node.updated_at = now();
  log(tree, author, "move", nid, `under ${newParent}`);
  return node;
}

function deleteNode(tree, nid, author) {
  getNode(tree, nid);
  if (nid === tree.root_id) throw new DTError("cannot delete the root goal; delete the tree file instead");
  const removed = new Set(descendants(tree, nid));
  for (const rid of removed) delete tree.nodes[rid];
  for (const node of Object.values(tree.nodes)) {
    node.links = node.links.filter((lk) => !removed.has(lk.target));
    if (removed.has(node.chosen)) node.chosen = null;
  }
  log(tree, author, "delete", nid, `${removed.size} node(s)`);
  return [...removed].sort();
}

function chooseOption(tree, oid, rationale, author, rejectSiblings = true) {
  const option = getNode(tree, oid);
  if (option.type !== "option") throw new DTError(`${oid} is a ${option.type}, not an option`);
  updateNode(tree, oid, { status: "chosen", rationale: rationale || option.rationale || "" }, author);
  const parent = option.parent ? tree.nodes[option.parent] : undefined;
  if (rejectSiblings && parent) {
    for (const sib of children(tree, parent.id)) {
      if (sib.type === "option" && sib.id !== oid && !["rejected", "deferred"].includes(sib.status)) {
        updateNode(tree, sib.id, { status: "rejected" }, author);
      }
    }
  }
  if (parent) {
    parent.chosen = oid;
    updateNode(tree, parent.id, { status: "decided" }, author);
  }
  log(tree, author, "choose", oid, rationale || "");
  return option;
}

function addLink(tree, src, dst, type, author) {
  const node = getNode(tree, src);
  getNode(tree, dst);
  choice(type, LINK_TYPES, "link type");
  if (src === dst) throw new DTError("cannot link a node to itself");
  const link = { target: dst, type };
  if (!node.links.some((lk) => same(lk, link))) {
    node.links.push(link);
    log(tree, author, "link", src, `${type} ${dst}`);
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

module.exports = { log, getNode, children, descendants, addNode, updateNode, moveNode, deleteNode, chooseOption, addLink, removeLink, updateTreeMeta };
