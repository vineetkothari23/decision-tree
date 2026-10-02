#!/usr/bin/env node
/*
 * dtree: question-driven decision trees for planning software features.
 *
 * Trees live as JSON files in <app>/.decisions/<tree-slug>.json. Agents use the
 * CLI; humans use the HTML viewer served by `dtree serve`. Node >= 18, no dependencies.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const net = require("node:net");
const { parseArgs } = require("node:util");

const VERSION = "0.1.2";
const SCHEMA_VERSION = 1;
const DECISIONS_DIR = ".decisions";
const TOOL_DIR = "_tool";
const SCRIPT_NAME = "dtree.cjs";
const VIEWER_HTML = path.join(__dirname, "viewer.html");
const SKILL_DIR = path.resolve(__dirname, "..");
const PACKAGE_NAME = "@vineetkothari23/decision-tree";

const NODE_TYPES = { goal: "g", question: "q", option: "o", decision: "d", task: "t", note: "n" };
const KINDS = ["why", "what", "how", "where", "who", "when", "risk", "other"];
const STATUSES = ["open", "exploring", "needs-input", "blocked", "decided", "chosen", "rejected", "deferred", "done"];
const TREE_STATUSES = ["draft", "active", "decided", "implemented", "archived"];
const LINK_TYPES = ["depends-on", "blocks", "relates-to", "supersedes", "duplicates"];
const AUTHOR_TYPES = ["agent", "human"];
const EDITABLE_NODE_FIELDS = ["title", "body", "kind", "status", "pros", "cons", "rationale", "assignee", "type"];
const ACTIVITY_LIMIT = 500;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CLOSED_STATUSES = new Set(["decided", "chosen", "rejected", "deferred", "done"]);
const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_MS = 30000;
const SCAN_SKIP = new Set(["node_modules", ".git", "venv", ".venv", "__pycache__", "dist", "build", "target"]);

class DTError extends Error {}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const realOrResolved = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function slugify(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 80) || "tree";
}

function validateSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new DTError(`invalid tree slug ${JSON.stringify(slug)}: use lowercase letters, digits, '.', '_', '-'`);
  }
  return slug;
}

function choice(value, allowed, what) {
  if (!allowed.includes(value)) {
    throw new DTError(`invalid ${what} ${JSON.stringify(value)}; expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(value)) throw new DTError("expected a list or a newline-separated string");
  return value.map((v) => String(v).trim()).filter(Boolean);
}

// --------------------------------------------------------------------------- store

/** One application's .decisions directory. */
class Store {
  constructor(projectRoot) {
    this.root = path.resolve(projectRoot);
    this.dir = path.join(this.root, DECISIONS_DIR);
  }

  get name() {
    return path.basename(this.root);
  }

  exists() {
    return isDir(this.dir);
  }

  init(refreshTool = false, { templates = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tool = path.join(this.dir, TOOL_DIR);
    const here = realOrResolved(__filename);
    if (path.dirname(here) !== realOrResolved(tool) && (refreshTool || !fs.existsSync(path.join(tool, SCRIPT_NAME)))) {
      fs.mkdirSync(tool, { recursive: true });
      fs.copyFileSync(here, path.join(tool, SCRIPT_NAME));
      fs.copyFileSync(VIEWER_HTML, path.join(tool, "viewer.html"));
      const builtins = builtinTemplatesDir();
      fs.rmSync(path.join(tool, TEMPLATES_DIR), { recursive: true, force: true });
      if (isDir(builtins)) fs.cpSync(builtins, path.join(tool, TEMPLATES_DIR), { recursive: true });
    }
    if (templates) {
      const dir = path.join(this.dir, TEMPLATES_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const example = path.join(dir, "example.yaml");
      if (!fs.existsSync(example)) fs.writeFileSync(example, EXAMPLE_TEMPLATE);
    }
    const readme = path.join(this.dir, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        "# Decisions\n\n" +
          "Each `*.json` file here is a decision tree for one feature, created with the\n" +
          "`decision-tree` skill (`dtree`). Nodes are goals, questions (why/what/how/where...),\n" +
          "options, decisions, tasks and notes, each with a status and a comment thread.\n\n" +
          "View, comment and coordinate in a browser (run from the app root, needs Node >= 18):\n\n" +
          `    node .decisions/_tool/${SCRIPT_NAME} serve        # http://127.0.0.1:8765\n` +
          `    npx ${PACKAGE_NAME} serve             # same, without the vendored copy\n\n` +
          `Agents: \`node .decisions/_tool/${SCRIPT_NAME} --help\`.\n`,
      );
    }
    const gitignore = path.join(this.dir, ".gitignore");
    if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, ".lock\n*.tmp\n");
  }

  treePath(slug) {
    return path.join(this.dir, `${validateSlug(slug)}.json`);
  }

  slugs() {
    if (!this.exists()) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && SLUG_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  load(slug) {
    const p = this.treePath(slug);
    if (!fs.existsSync(p)) throw new DTError(`tree ${JSON.stringify(slug)} not found in ${this.dir}`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  withLock(fn) {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, ".lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let fd;
    for (;;) {
      try {
        fd = fs.openSync(lock, "wx");
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true });
        } catch {
          // lock vanished between open and stat; retry
        }
        if (Date.now() > deadline) {
          throw new DTError(`timed out waiting for ${lock}; delete it if no dtree process is running`);
        }
        sleep(20);
      }
    }
    try {
      fs.writeSync(fd, String(process.pid));
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }

  write(tree) {
    const target = this.treePath(tree.id);
    const tmp = path.join(this.dir, `.${tree.id}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(tree, null, 2) + "\n");
    fs.renameSync(tmp, target);
  }

  /** Load a tree under the lock, let `fn` mutate it, then bump the revision and write atomically. */
  edit(slug, fn) {
    return this.withLock(() => {
      const tree = this.load(slug);
      const result = fn(tree);
      tree.revision = (tree.revision || 0) + 1;
      tree.updated_at = now();
      this.write(tree);
      return result;
    });
  }

  /** Creates a tree; `template` (from resolveTemplate) seeds its nodes in the same locked write. */
  createTree(slug, title, description, author, template = null) {
    this.init();
    return this.withLock(() => {
      if (fs.existsSync(this.treePath(slug))) throw new DTError(`tree ${JSON.stringify(slug)} already exists`);
      const ts = now();
      const tree = {
        schema_version: SCHEMA_VERSION,
        id: slug,
        title,
        description,
        status: "draft",
        created_at: ts,
        updated_at: ts,
        created_by: author,
        revision: 1,
        next_id: 1,
        root_id: null,
        nodes: {},
        activity: [],
      };
      if (template) tree.template = template.name;
      const root = addNode(tree, { parent: null, type: "goal", title, body: description, author });
      tree.root_id = root.id;
      if (template) applyTemplate(tree, template, author);
      this.write(tree);
      return tree;
    });
  }

  summaries() {
    return this.slugs().map((slug) => {
      try {
        return summarize(this.load(slug));
      } catch (e) {
        return { id: slug, title: slug, error: e.message };
      }
    });
  }
}

function findProjectRoot(start) {
  let cur = path.resolve(start);
  for (;;) {
    if (isDir(path.join(cur, DECISIONS_DIR))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const here = path.dirname(realOrResolved(__filename));
  if (path.basename(here) === TOOL_DIR && path.basename(path.dirname(here)) === DECISIONS_DIR) {
    return path.dirname(path.dirname(here));
  }
  return path.resolve(start);
}

function scanProjects(base, maxDepth = 4) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.includes(DECISIONS_DIR)) found.push(dir);
    if (depth >= maxDepth) return;
    for (const d of dirs.sort()) {
      if (!SCAN_SKIP.has(d) && !d.startsWith(".")) walk(path.join(dir, d), depth + 1);
    }
  };
  walk(path.resolve(base), 0);
  return found;
}

// --------------------------------------------------------------------------- tree operations

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

function addComment(tree, nid, text, author, replyTo = null) {
  const node = getNode(tree, nid);
  if (!text || !String(text).trim()) throw new DTError("comment text is required");
  if (replyTo && !node.comments.some((c) => c.id === replyTo)) {
    throw new DTError(`comment ${JSON.stringify(replyTo)} not found on ${nid}`);
  }
  const comment = {
    id: `c${tree.next_id}`,
    author: author.name,
    author_type: author.type,
    text: String(text).trim(),
    reply_to: replyTo || null,
    resolved: false,
    created_at: now(),
  };
  tree.next_id += 1;
  node.comments.push(comment);
  log(tree, author, "comment", nid, comment.text.slice(0, 120));
  return comment;
}

function resolveComment(tree, nid, cid, resolved, author) {
  const node = getNode(tree, nid);
  const found = node.comments.find((x) => x.id === cid);
  if (!found) throw new DTError(`comment ${JSON.stringify(cid)} not found on ${nid}`);
  const c = threadRoot(node, found);
  c.resolved = resolved;
  log(tree, author, resolved ? "resolve" : "reopen", nid, c.id);
  return c;
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

function threadRoot(node, comment) {
  const byId = new Map(node.comments.map((c) => [c.id, c]));
  const seen = new Set([comment.id]);
  let c = comment;
  while (c.reply_to && byId.has(c.reply_to) && !seen.has(c.reply_to)) {
    c = byId.get(c.reply_to);
    seen.add(c.id);
  }
  return c;
}

/** Comment threads on a node: [root, ...replies], with replies-to-replies grouped under their root. */
function threads(node) {
  const groups = new Map();
  for (const c of node.comments) {
    const root = threadRoot(node, c);
    if (!groups.has(root.id)) groups.set(root.id, [root]);
    if (c !== root) groups.get(root.id).push(c);
  }
  return [...groups.values()];
}

/** Items waiting on `audience` ('agent' or 'human'). */
function inbox(tree, audience) {
  const other = audience === "agent" ? "human" : "agent";
  const items = [];
  for (const node of Object.values(tree.nodes)) {
    for (const msgs of threads(node)) {
      const last = msgs[msgs.length - 1];
      if (!msgs[0].resolved && last.author_type === other) {
        items.push({ node: node.id, title: node.title, kind: "comment", thread: msgs[0].id, last });
      }
    }
    if (audience === "human" && node.status === "needs-input") {
      items.push({ node: node.id, title: node.title, kind: "needs-input" });
    }
  }
  return items;
}

/** Gaps an agent should address to make the tree rigorous. */
function review(tree) {
  const issues = [];
  const nodes = Object.values(tree.nodes);
  const root = tree.nodes[tree.root_id];
  if (root) {
    const kinds = new Set(nodes.filter((n) => n.type === "question").map((n) => n.kind));
    const missing = ["why", "what", "how", "where"].filter((k) => !kinds.has(k));
    if (missing.length) issues.push([root.id, `no ${missing.join("/")} questions asked yet`]);
  }
  for (const n of nodes) {
    const kids = children(tree, n.id);
    const opts = kids.filter((k) => k.type === "option");
    if (n.type === "question") {
      if (!["decided", "deferred", "done", "rejected"].includes(n.status) && opts.length < 2) {
        issues.push([n.id, `open question has ${opts.length} option(s); propose at least 2`]);
      }
      if (n.status === "decided" && !n.chosen && !opts.some((o) => o.status === "chosen")) {
        issues.push([n.id, "marked decided but no option is chosen"]);
      }
    }
    if (n.type === "option" && !["rejected", "deferred"].includes(n.status)) {
      if (!n.pros.length || !n.cons.length) issues.push([n.id, "option lacks pros and/or cons"]);
      if (n.status === "chosen" && !n.rationale) issues.push([n.id, "chosen option has no rationale"]);
      if (n.status === "chosen" && !kids.some((k) => k.type === "question")) {
        issues.push([n.id, "chosen option has no follow-up questions (how/where/what next?)"]);
      }
    }
    if (n.type === "question" && n.status === "blocked" && !n.links.length) {
      issues.push([n.id, "blocked but no depends-on/blocks link explains why"]);
    }
  }
  for (const item of inbox(tree, "agent")) {
    issues.push([item.node, `unanswered human comment ${item.thread}: ${item.last.text.slice(0, 80)}`]);
  }
  return issues;
}

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

function renderText(tree, showBody = false) {
  const lines = [];
  const label = (n) => {
    const kind = n.kind ? `${n.kind.toUpperCase()}: ` : "";
    const marks = [];
    if (n.comments.length) {
      const open = threads(n).filter((t) => !t[0].resolved).length;
      marks.push(`${n.comments.length} comment(s), ${open} open`);
    }
    if (n.links.length) marks.push(n.links.map((lk) => `${lk.type} ${lk.target}`).join(", "));
    if (n.assignee) marks.push(`@${n.assignee}`);
    const tail = marks.length ? `  <${marks.join("; ")}>` : "";
    return `[${n.id}] ${n.type} ${kind}${n.title}  (${n.status})${tail}`;
  };
  const walk = (nid, prefix, last, top) => {
    const n = tree.nodes[nid];
    const connector = top ? "" : last ? "└── " : "├── ";
    lines.push(prefix + connector + label(n));
    const childPrefix = top ? prefix : prefix + (last ? "    " : "│   ");
    if (showBody) {
      const texts = [...(n.body ? [n.body] : []), ...(n.rationale ? [`rationale: ${n.rationale}`] : [])];
      for (const text of texts) for (const line of text.split(/\r?\n/)) lines.push(`${childPrefix}  │ ${line}`);
    }
    const kids = children(tree, nid);
    kids.forEach((k, i) => walk(k.id, childPrefix, i === kids.length - 1, false));
  };
  lines.push(`# ${tree.title}  [${tree.id}] (${tree.status ?? "draft"}, rev ${tree.revision ?? 0})`);
  if (tree.nodes[tree.root_id]) walk(tree.root_id, "", true, true);
  return lines.join("\n");
}

const meta = () => ({
  node_types: Object.keys(NODE_TYPES),
  kinds: KINDS,
  statuses: STATUSES,
  tree_statuses: TREE_STATUSES,
  link_types: LINK_TYPES,
});

function renderStaticHtml(payload) {
  const html = fs.readFileSync(VIEWER_HTML, "utf8");
  const data = JSON.stringify(payload).replace(/<\//g, "<\\/");
  return html.replace("<!--DTREE_STATIC-->", () => `<script>window.DTREE_STATIC = ${data};</script>`);
}

// --------------------------------------------------------------------------- YAML subset

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const SEQ_ITEM_RE = /^-(\s|$)/;

function stripComment(s) {
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "#" && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd();
  }
  return s.trimEnd();
}

/** Index of the closing quote of the quoted string starting at `start`, or -1. */
function quotedEnd(s, start = 0) {
  const q = s[start];
  for (let k = start + 1; k < s.length; k++) {
    if (q === '"' && s[k] === "\\") k++;
    else if (q === "'" && s[k] === "'" && s[k + 1] === "'") k++;
    else if (s[k] === q) return k;
  }
  return -1;
}

function plainScalar(s) {
  if (/^(~|null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s);
  return s;
}

const YAML_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/", " ": " ", 0: "\0" };

/**
 * Parser for the YAML subset used by templates: comments, block mappings and sequences,
 * plain/quoted scalars, single-line flow sequences of scalars, `[]`/`{}`, and `|`/`>` blocks.
 * Anything else raises a DTError with `file:line`.
 */
class YamlParser {
  constructor(text, file) {
    this.file = file || "<yaml>";
    this.lines = String(text).replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    if (this.lines.length > 1 && this.lines[this.lines.length - 1] === "") this.lines.pop();
    this.i = 0;
    this.started = false;
  }

  fail(msg) {
    throw new DTError(`${this.file}:${Math.min(this.i, this.lines.length - 1) + 1}: ${msg}`);
  }

  /** Next significant line as {indent, text}, skipping blanks and comments; null at EOF. */
  peek() {
    while (this.i < this.lines.length) {
      const m = /^([ \t]*)(.*)$/.exec(this.lines[this.i]);
      const text = m[2].trimEnd();
      if (!text || text.startsWith("#")) {
        this.i++;
        continue;
      }
      if (m[1].includes("\t")) this.fail("tabs are not allowed for indentation; use spaces");
      const indent = m[1].length;
      if (indent === 0 && /^---(\s|$)/.test(text)) {
        if (this.started) this.fail("multiple documents ('---') are not supported");
        if (stripComment(text.slice(3)).trim()) this.fail("content after '---' is not supported");
        this.started = true;
        this.i++;
        continue;
      }
      if (indent === 0 && /^\.\.\.(\s|$)/.test(text)) this.fail("document end marker ('...') is not supported");
      if (indent === 0 && text.startsWith("%")) this.fail("YAML directives ('%') are not supported");
      this.started = true;
      return { indent, text };
    }
    return null;
  }

  parse() {
    if (!this.peek()) return null;
    const value = this.node();
    if (this.peek()) this.fail("unexpected content (check the indentation)");
    return value;
  }

  node() {
    const ln = this.peek();
    if (SEQ_ITEM_RE.test(ln.text)) return this.seq(ln.indent);
    if (this.splitKey(ln.text)) return this.map(ln.indent);
    return this.value(ln.text, ln.indent - 1, false);
  }

  /** `key: rest` → {key, rest}; null if the line is not a mapping entry. */
  splitKey(text) {
    if (text === "?" || text.startsWith("? ")) this.fail("complex keys ('? ') are not supported");
    if (text[0] === '"' || text[0] === "'") {
      const end = quotedEnd(text);
      if (end < 0) return null;
      const m = /^\s*:(\s|$)/.exec(text.slice(end + 1));
      if (!m) return null;
      return { key: this.quoted(text.slice(0, end + 1)), rest: text.slice(end + 1 + m[0].length).trim() };
    }
    if (/^[[\]{}&*!|>%@`,#]/.test(text)) return null;
    const m = /:(\s|$)/.exec(text);
    if (!m) return null;
    const key = text.slice(0, m.index).trimEnd();
    if (/\s#/.test(key)) return null;
    return { key, rest: text.slice(m.index + 1).trim() };
  }

  map(indent) {
    const out = {};
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) this.fail("unexpected indentation (multi-line plain scalars are not supported; use | or quotes)");
      if (SEQ_ITEM_RE.test(ln.text)) this.fail("unexpected list item inside a mapping (check the indentation)");
      const kv = this.splitKey(ln.text);
      if (!kv) this.fail("expected a 'key: value' mapping entry");
      if (hasOwn(out, kv.key)) this.fail(`duplicate key ${JSON.stringify(kv.key)}`);
      const value = this.value(kv.rest, indent, true);
      Object.defineProperty(out, kv.key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  seq(indent) {
    const out = [];
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) this.fail("unexpected indentation (check the list item alignment)");
      if (!SEQ_ITEM_RE.test(ln.text)) break;
      const after = ln.text.slice(1);
      if (/^ *\t/.test(after)) this.fail("tabs are not allowed for indentation; use spaces");
      const rest = after.trimStart();
      if (rest && !rest.startsWith("#") && (SEQ_ITEM_RE.test(rest) || this.splitKey(rest))) {
        const col = indent + 1 + (after.length - rest.length);
        this.lines[this.i] = " ".repeat(col) + rest;
        out.push(this.node());
      } else {
        out.push(this.value(rest, indent, false));
      }
    }
    return out;
  }

  /** Value after `key:` or `- ` on the current line; nested blocks must be indented past `parentIndent`. */
  value(rest, parentIndent, inMap) {
    if (!rest || rest.startsWith("#")) {
      this.i++;
      const next = this.peek();
      if (next && (next.indent > parentIndent || (inMap && next.indent === parentIndent && SEQ_ITEM_RE.test(next.text)))) {
        return this.node();
      }
      return null;
    }
    if (rest[0] === "|" || rest[0] === ">") return this.block(rest, parentIndent);
    const v = this.scalar(rest);
    this.i++;
    return v;
  }

  checkTail(tail) {
    if (tail.trim() && !/^\s+#/.test(tail)) this.fail(`unexpected text after value: ${JSON.stringify(tail.trim())}`);
  }

  quoted(s) {
    const inner = s.slice(1, -1);
    if (s[0] === "'") return inner.replace(/''/g, "'");
    return inner.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, ch) => {
      if (ch.length === 5) return String.fromCharCode(parseInt(ch.slice(1), 16));
      if (!hasOwn(YAML_ESCAPES, ch)) this.fail(`unsupported escape '\\${ch}' in double-quoted string`);
      return YAML_ESCAPES[ch];
    });
  }

  rejectSpecial(c) {
    if (c === "&") this.fail("anchors ('&') are not supported");
    if (c === "*") this.fail("aliases ('*') are not supported");
    if (c === "!") this.fail("tags ('!') are not supported");
    if (c === "@" || c === "`") this.fail(`a plain value cannot start with '${c}'; quote it`);
  }

  scalar(text) {
    const c = text[0];
    this.rejectSpecial(c);
    if (c === '"' || c === "'") {
      const end = quotedEnd(text);
      if (end < 0) this.fail("unterminated quoted string (multi-line quoted strings are not supported; use |)");
      this.checkTail(text.slice(end + 1));
      return this.quoted(text.slice(0, end + 1));
    }
    if (c === "[") return this.flowSeq(text);
    if (c === "{") {
      const m = /^\{\s*\}(.*)$/.exec(text);
      if (!m) this.fail("flow mappings ('{...}') are not supported; use a block mapping");
      this.checkTail(m[1]);
      return {};
    }
    const v = stripComment(text);
    if (/:(\s|$)/.test(v)) this.fail("unexpected ': ' in a plain value; quote the string");
    return plainScalar(v);
  }

  flowSeq(text) {
    const items = [];
    let k = 1;
    const ws = () => {
      while (k < text.length && /\s/.test(text[k])) k++;
    };
    ws();
    if (text[k] === "]") k++;
    else {
      for (;;) {
        ws();
        const c = text[k];
        if (c === undefined) this.fail("unterminated flow sequence (it must close with ']' on the same line)");
        this.rejectSpecial(c);
        if (c === "[" || c === "{") this.fail("nested flow collections are not supported");
        if (c === "," || c === "]") this.fail("empty item in flow sequence");
        if (c === '"' || c === "'") {
          const end = quotedEnd(text, k);
          if (end < 0) this.fail("unterminated quoted string in flow sequence");
          items.push(this.quoted(text.slice(k, end + 1)));
          k = end + 1;
        } else {
          let e = k;
          while (e < text.length && text[e] !== "," && text[e] !== "]" && !(text[e] === "#" && /\s/.test(text[e - 1]))) e++;
          const raw = text.slice(k, e).trim();
          if (/:(\s|$)/.test(raw)) this.fail("mappings inside flow sequences are not supported");
          items.push(plainScalar(raw));
          k = e;
        }
        ws();
        if (text[k] === ",") {
          k++;
          ws();
          if (text[k] === "]") {
            k++;
            break;
          }
          continue;
        }
        if (text[k] === "]") {
          k++;
          break;
        }
        this.fail("expected ',' or ']' in flow sequence (it must close on the same line)");
      }
    }
    this.checkTail(text.slice(k));
    return items;
  }

  block(header, parentIndent) {
    const m = /^([|>])([+-]?)(\s+#.*)?$/.exec(header);
    if (!m) this.fail(`unsupported block scalar header ${JSON.stringify(header)} (use |, |-, |+, >, >- or >+)`);
    this.i++;
    let ind = null;
    const body = [];
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i];
      if (raw.trim()) {
        const lead = raw.length - raw.replace(/^ +/, "").length;
        if (ind === null) {
          if (lead <= parentIndent) break;
          if (raw[lead] === "\t") this.fail("tabs are not allowed for indentation; use spaces");
          ind = lead;
        } else if (lead < ind) break;
      }
      body.push(raw);
      this.i++;
    }
    if (ind === null) return m[2] === "+" ? "\n".repeat(body.length) : "";
    const lines = body.map((l) => (l.length > ind ? l.slice(ind) : ""));
    let n = lines.length;
    while (n && !lines[n - 1].trim()) n--;
    const content = lines.slice(0, n);
    const text = m[1] === "|" ? content.join("\n") : foldLines(content);
    if (m[2] === "-") return text;
    if (m[2] === "+") return text + "\n".repeat(lines.length - n + 1);
    return text + "\n";
  }
}

function foldLines(lines) {
  let out = "";
  let prev = null;
  let blanks = 0;
  for (const l of lines) {
    if (!l.trim()) {
      blanks++;
      out += "\n";
      continue;
    }
    if (prev === null) out += l;
    else {
      const more = /^\s/.test(l) || /^\s/.test(prev);
      out += blanks ? (more ? "\n" : "") + l : (more ? "\n" : " ") + l;
    }
    prev = l;
    blanks = 0;
  }
  return out;
}

function parseYaml(text, file) {
  return new YamlParser(text, file).parse();
}

const hasControlChars = (s, allowNewline = false) =>
  [...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return (c < 0x20 || c === 0x7f) && !(allowNewline && ch === "\n");
  });

function yamlNeedsQuotes(s, flow) {
  return (
    s === "" ||
    s !== s.trim() ||
    hasControlChars(s) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /:(\s|$)|\s#/.test(s) ||
    (flow && /[,[\]{}]/.test(s)) ||
    plainScalar(s) !== s
  );
}

function yamlScalar(v, flow = false) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  return yamlNeedsQuotes(s, flow) ? JSON.stringify(s) : s;
}

function yamlBlockable(s) {
  if (!s.includes("\n") || hasControlChars(s, true)) return false;
  const lines = s.replace(/\n+$/, "").split("\n");
  const first = lines.find((l) => l !== "");
  return first !== undefined && !/^\s/.test(first) && !lines.some((l) => l !== "" && !l.trim());
}

function yamlEntry(prefix, v, pad) {
  if (Array.isArray(v)) {
    if (!v.length) return [`${prefix} []`];
    if (v.every((x) => !isPlainObject(x) && !Array.isArray(x))) {
      const flow = `${prefix} [${v.map((x) => yamlScalar(x, true)).join(", ")}]`;
      if (flow.length <= 100) return [flow];
    }
  }
  if (isPlainObject(v) && !Object.keys(v).length) return [`${prefix} {}`];
  if (Array.isArray(v) || isPlainObject(v)) {
    const sub = yamlLines(v, pad);
    if (prefix.endsWith("-")) return [`${prefix} ${sub[0].slice(pad.length)}`, ...sub.slice(1)];
    return [prefix, ...sub];
  }
  if (typeof v === "string" && yamlBlockable(v)) {
    const trailing = /\n*$/.exec(v)[0].length;
    const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
    const lines = v.replace(/\n+$/, "").split("\n");
    for (let k = 1; k < trailing; k++) lines.push("");
    return [`${prefix} |${chomp}`, ...lines.map((l) => (l ? pad + l : ""))];
  }
  return [`${prefix} ${yamlScalar(v)}`];
}

function yamlLines(v, pad) {
  if (Array.isArray(v)) return v.flatMap((item) => yamlEntry(`${pad}-`, item, `${pad}  `));
  return Object.entries(v).flatMap(([k, item]) => {
    const key = /^[A-Za-z_][\w.-]*$/.test(k) && plainScalar(k) === k ? k : JSON.stringify(k);
    return yamlEntry(`${pad}${key}:`, item, `${pad}  `);
  });
}

/** Emits block-style YAML that `parseYaml` reads back to an equal value. */
function stringifyYaml(value) {
  if (!Array.isArray(value) && !isPlainObject(value)) return yamlScalar(value) + "\n";
  return yamlEntry("", value, "")
    .map((l, k) => (k === 0 ? l.trimStart() : l))
    .filter((l, k) => !(k === 0 && l === ""))
    .join("\n") + "\n";
}

// --------------------------------------------------------------------------- templates

const TEMPLATE_VERSION = 1;
const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TEMPLATE_EXTS = [".yaml", ".yml", ".json"];
const TEMPLATES_DIR = "templates";
const TEMPLATE_KEYS = ["template", "name", "title", "description", "tree_status", "nodes"];
const TEMPLATE_NODE_KEYS = ["title", "type", "kind", "body", "status", "assignee", "pros", "cons", "children"];
const TEMPLATE_PATH_RE = /[\\/]|\.(ya?ml|json)$/i;

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const templateNameOf = (file) => path.basename(file).replace(/\.(ya?ml|json)$/i, "");

/** Validates parsed template data and returns it normalized (defaults filled in). */
function validateTemplate(data, { label, name = null }) {
  const fail = (where, msg) => {
    throw new DTError(`template ${label}: ${where ? `${where}: ` : ""}${msg}`);
  };
  const text = (v, where, key) => {
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return fail(where, `${JSON.stringify(key)} must be a string`);
  };
  if (!isPlainObject(data)) fail("", "must be a mapping with template, name, title and nodes");
  for (const k of Object.keys(data)) {
    if (!TEMPLATE_KEYS.includes(k)) fail("", `unknown key ${JSON.stringify(k)} (allowed: ${TEMPLATE_KEYS.join(", ")})`);
  }
  if (data.template === undefined) fail("", `missing required key "template" (format version, use ${TEMPLATE_VERSION})`);
  if (data.template !== TEMPLATE_VERSION) {
    fail("template", `unsupported format version ${JSON.stringify(data.template)}; expected ${TEMPLATE_VERSION}`);
  }
  if (data.name === undefined || data.name === null) fail("", 'missing required key "name"');
  if (typeof data.name !== "string" || !TEMPLATE_NAME_RE.test(data.name)) {
    fail("name", `invalid name ${JSON.stringify(data.name)}: use lowercase letters, digits, '-' and '_'`);
  }
  if (name !== null && data.name !== name) fail("name", `${JSON.stringify(data.name)} must match the file name ${JSON.stringify(name)}`);
  const title = text(data.title, "title", "title").trim();
  if (!title) fail("", 'missing required key "title"');
  const treeStatus = data.tree_status ?? null;
  if (treeStatus !== null && !TREE_STATUSES.includes(treeStatus)) {
    fail("tree_status", `invalid tree status ${JSON.stringify(treeStatus)}; expected one of: ${TREE_STATUSES.join(", ")}`);
  }
  const list = (v, where) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) fail(where, "must be a list");
    return v;
  };
  const strings = (v, where, key) => {
    const items = typeof v === "string" ? [v] : list(v, where ? `${where}.${key}` : key);
    return items.map((x, k) => text(x, `${where}.${key}[${k}]`, key).trim()).filter(Boolean);
  };
  const node = (raw, where) => {
    if (!isPlainObject(raw)) fail(where, "must be a mapping with at least a title");
    for (const k of Object.keys(raw)) {
      if (!TEMPLATE_NODE_KEYS.includes(k)) fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${TEMPLATE_NODE_KEYS.join(", ")})`);
    }
    const nodeTitle = text(raw.title, where, "title").trim();
    if (!nodeTitle) fail(where, 'missing required "title"');
    const type = raw.type ?? "question";
    if (type === "goal") fail(where, 'type "goal" is reserved for the root; use question, option, decision, task or note');
    if (!Object.keys(NODE_TYPES).includes(type)) {
      fail(where, `invalid type ${JSON.stringify(type)}; expected one of: question, option, decision, task, note`);
    }
    const kind = raw.kind ?? null;
    if (kind !== null) {
      if (type !== "question") fail(where, `"kind" is only allowed on questions (this node is a ${type})`);
      if (!KINDS.includes(kind)) fail(where, `invalid kind ${JSON.stringify(kind)}; expected one of: ${KINDS.join(", ")}`);
    }
    const status = raw.status ?? "open";
    if (!STATUSES.includes(status)) fail(where, `invalid status ${JSON.stringify(status)}; expected one of: ${STATUSES.join(", ")}`);
    for (const key of ["pros", "cons"]) {
      if (raw[key] !== undefined && raw[key] !== null && type !== "option") {
        fail(where, `${JSON.stringify(key)} is only allowed on options (this node is a ${type})`);
      }
    }
    return {
      title: nodeTitle,
      type,
      kind,
      body: text(raw.body, where, "body").replace(/\n+$/, ""),
      status,
      assignee: text(raw.assignee, where, "assignee").trim(),
      pros: strings(raw.pros, where, "pros"),
      cons: strings(raw.cons, where, "cons"),
      children: list(raw.children, `${where}.children`).map((c, k) => node(c, `${where}.children[${k}]`)),
    };
  };
  const nodes = list(data.nodes, "nodes");
  if (!nodes.length) fail("nodes", "must be a non-empty list of nodes to add under the root goal");
  return {
    template: TEMPLATE_VERSION,
    name: data.name,
    title,
    description: text(data.description, "description", "description").replace(/\n+$/, ""),
    tree_status: treeStatus,
    nodes: nodes.map((n, k) => node(n, `nodes[${k}]`)),
  };
}

function readTemplateFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new DTError(`cannot read template ${file}: ${e.code || e.message}`);
  }
  if (path.extname(file).toLowerCase() === ".json") {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new DTError(`${file}: invalid JSON: ${e.message}`);
    }
  }
  return parseYaml(text, file);
}

function loadTemplate(file, source = "path") {
  const name = templateNameOf(file);
  const tpl = validateTemplate(readTemplateFile(file), { label: `${JSON.stringify(name)} (${file})`, name });
  return { ...tpl, source, path: file };
}

function builtinTemplatesDir() {
  const here = path.dirname(realOrResolved(__filename));
  return path.basename(here) === TOOL_DIR ? path.join(here, TEMPLATES_DIR) : path.join(here, "..", TEMPLATES_DIR);
}

function userTemplatesDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "decision-tree", TEMPLATES_DIR);
}

/** Template directories in lookup order: project, $DTREE_TEMPLATES_PATH, user config, built-in. */
function templateDirs(store) {
  const dirs = [{ source: "project", dir: path.join(store.dir, TEMPLATES_DIR) }];
  for (const d of (process.env.DTREE_TEMPLATES_PATH || "").split(path.delimiter).filter(Boolean)) {
    dirs.push({ source: "user", dir: path.resolve(d) });
  }
  dirs.push({ source: "user", dir: userTemplatesDir() }, { source: "builtin", dir: builtinTemplatesDir() });
  const seen = new Set();
  return dirs.filter(({ dir }) => {
    const key = realOrResolved(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const templateFiles = (dir, name) => TEMPLATE_EXTS.map((ext) => path.join(dir, name + ext)).filter(isFile);

function validateTemplateName(name) {
  if (typeof name !== "string" || !TEMPLATE_NAME_RE.test(name)) {
    throw new DTError(`invalid template name ${JSON.stringify(name)}: use lowercase letters, digits, '-' and '_'`);
  }
  return name;
}

/** Finds a template by file path or name (project > user > built-in). */
function resolveTemplate(store, arg, { allowPath = true } = {}) {
  if (TEMPLATE_PATH_RE.test(arg)) {
    if (!allowPath) throw new DTError(`template must be a name, not a path: ${JSON.stringify(arg)}`);
    const file = path.resolve(arg);
    if (!isFile(file)) throw new DTError(`template file ${arg} not found`);
    return loadTemplate(file, "path");
  }
  validateTemplateName(arg);
  const dirs = templateDirs(store);
  for (const { source, dir } of dirs) {
    const [file] = templateFiles(dir, arg);
    if (file) return loadTemplate(file, source);
  }
  throw new DTError(`template ${JSON.stringify(arg)} not found; run \`dtree templates\` to list them ` +
    `(searched ${dirs.map((d) => d.dir).join(", ")})`);
}

/** Every template found, in precedence order; `active` is false when an earlier directory shadows it. */
function listTemplates(store) {
  const rows = [];
  const winners = new Map();
  for (const { source, dir } of templateDirs(store)) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const names = [...new Set(files.filter((f) => TEMPLATE_PATH_RE.test(f)).map(templateNameOf))]
      .filter((n) => TEMPLATE_NAME_RE.test(n))
      .sort();
    for (const name of names) {
      const [file] = templateFiles(dir, name);
      if (!file) continue;
      const row = { name, title: name, description: "", source, path: file, active: !winners.has(name), shadowed_by: null };
      if (!row.active) row.shadowed_by = winners.get(name);
      else winners.set(name, { source, path: file });
      try {
        const tpl = loadTemplate(file, source);
        row.title = tpl.title;
        row.description = tpl.description;
        row.nodes = countTemplateNodes(tpl.nodes);
      } catch (e) {
        if (!(e instanceof DTError)) throw e;
        row.error = e.message;
      }
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || Number(b.active) - Number(a.active));
}

const countTemplateNodes = (nodes) => nodes.reduce((acc, n) => acc + 1 + countTemplateNodes(n.children), 0);

/** Adds a validated template's nodes under the root goal, preserving order and nesting. */
function applyTemplate(tree, tpl, author) {
  const walk = (list, parent) => {
    for (const n of list) {
      const node = addNode(tree, {
        parent,
        type: n.type,
        title: n.title,
        body: n.body,
        kind: n.kind,
        status: n.status,
        author,
        pros: n.pros,
        cons: n.cons,
        assignee: n.assignee,
      });
      walk(n.children, node.id);
    }
  };
  walk(tpl.nodes, tree.root_id);
  if (tpl.tree_status) tree.status = tpl.tree_status;
  log(tree, author, "template", tree.root_id, `${tpl.name} (${tpl.source || "path"}): ${countTemplateNodes(tpl.nodes)} node(s)`);
}

/** A tree's structure (non-root nodes, without statuses, comments or history) as template data. */
function treeToTemplate(tree, name) {
  validateTemplateName(name);
  const conv = (n) => {
    const type = n.type === "goal" ? "note" : n.type;
    const out = { title: n.title };
    if (type !== "question") out.type = type;
    if (type === "question" && n.kind) out.kind = n.kind;
    if (n.body) out.body = n.body;
    if (type === "option" && n.pros && n.pros.length) out.pros = [...n.pros];
    if (type === "option" && n.cons && n.cons.length) out.cons = [...n.cons];
    const kids = children(tree, n.id).map(conv);
    if (kids.length) out.children = kids;
    return out;
  };
  const nodes = children(tree, tree.root_id).map(conv);
  if (!nodes.length) throw new DTError(`tree ${JSON.stringify(tree.id)} has no nodes under the root goal to export`);
  const tpl = { template: TEMPLATE_VERSION, name, title: tree.title || name };
  if (tree.description) tpl.description = tree.description;
  tpl.nodes = nodes;
  return tpl;
}

function renderTemplate(tpl) {
  const lines = [`# ${tpl.title}  [${tpl.name}] (${tpl.source || "path"}: ${tpl.path || "-"})`];
  if (tpl.tree_status) lines.push(`tree status: ${tpl.tree_status}`);
  for (const l of tpl.description.replace(/\n+$/, "").split("\n")) if (tpl.description) lines.push(`  ${l}`);
  const walk = (list, depth) => {
    for (const n of list) {
      const pad = "  ".repeat(depth);
      const kind = n.kind ? `${n.kind.toUpperCase()}: ` : "";
      const extra = [n.status !== "open" ? n.status : "", n.assignee ? `@${n.assignee}` : ""].filter(Boolean).join(", ");
      lines.push(`${pad}- ${n.type} ${kind}${n.title}${extra ? `  (${extra})` : ""}`);
      for (const l of n.body.replace(/\n+$/, "").split("\n")) if (n.body) lines.push(`${pad}    │ ${l}`);
      if (n.pros.length) lines.push(`${pad}    pros: ${n.pros.join("; ")}`);
      if (n.cons.length) lines.push(`${pad}    cons: ${n.cons.join("; ")}`);
      walk(n.children, depth + 1);
    }
  };
  walk(tpl.nodes, 0);
  return lines.join("\n");
}

/** Writes a tree's structure as a template file (YAML, or JSON for `.json`); `out` may be a directory. */
function exportTemplate(tree, out, name) {
  let file = path.resolve(out);
  if (isDir(file) || /[\\/]$/.test(out)) file = path.join(file, `${name || validateTemplateName(slugify(tree.id))}.yaml`);
  if (!/\.(ya?ml|json)$/i.test(file)) throw new DTError(`template file ${out} must end in .yaml, .yml or .json`);
  const fileName = templateNameOf(file);
  if (name && name !== fileName) {
    throw new DTError(`--name ${JSON.stringify(name)} must match the output file name ${JSON.stringify(fileName)} (or pass a directory to -o)`);
  }
  const data = treeToTemplate(tree, name || fileName);
  const text = path.extname(file).toLowerCase() === ".json" ? JSON.stringify(data, null, 2) + "\n" : stringifyYaml(data);
  const tpl = validateTemplate(path.extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text, file), {
    label: JSON.stringify(data.name),
    name: data.name,
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { name: tpl.name, path: file, nodes: countTemplateNodes(tpl.nodes) };
}

function modeDir(store, user) {
  return user ? { source: "user", dir: userTemplatesDir() } : { source: "project", dir: path.join(store.dir, TEMPLATES_DIR) };
}

/** Validates a YAML/JSON template file and saves it as `<name>.yaml` in the project (or user) template dir. */
function createMode(store, name, file, { user = false, force = false } = {}) {
  validateTemplateName(name);
  const src = path.resolve(file);
  if (!isFile(src)) throw new DTError(`template file ${file} not found`);
  const data = readTemplateFile(src);
  if (isPlainObject(data)) data.name = name;
  const label = `${JSON.stringify(name)} (${src})`;
  validateTemplate(data, { label, name });
  let text = null;
  if (!/\.json$/i.test(src)) {
    const raw = fs.readFileSync(src, "utf8").replace(/^\uFEFF/, "");
    const renamed = /^name:.*$/m.test(raw) ? raw.replace(/^name:.*$/m, `name: ${name}`) : null;
    try {
      if (renamed !== null && same(parseYaml(renamed, src), data)) text = renamed;
    } catch (e) {
      if (!(e instanceof DTError)) throw e;
    }
  }
  if (text === null) text = stringifyYaml(data);
  validateTemplate(parseYaml(text, src), { label, name });
  const { source, dir } = modeDir(store, user);
  const dest = path.join(dir, `${name}.yaml`);
  const existing = templateFiles(dir, name);
  if (existing.length && !force) {
    throw new DTError(`${source} mode ${JSON.stringify(name)} already exists at ${existing[0]}; pass --force to overwrite`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text.endsWith("\n") ? text : text + "\n");
  fs.renameSync(tmp, dest);
  for (const f of existing) if (f !== dest) fs.rmSync(f, { force: true });
  const shadowed = listTemplates(store).find((r) => r.name === name && r.path !== dest && !r.active);
  return { name, source, path: dest, shadows: shadowed ? { source: shadowed.source, path: shadowed.path } : null };
}

/** Deletes a project (or user) template; built-in templates can never be removed. */
function removeMode(store, name, { user = false } = {}) {
  validateTemplateName(name);
  const { source, dir } = modeDir(store, user);
  const files = templateFiles(dir, name);
  if (!files.length) {
    const other = listTemplates(store).find((r) => r.name === name);
    if (other && other.source === "builtin") {
      throw new DTError(`${JSON.stringify(name)} is a built-in template and cannot be removed ` +
        `(shadow it with \`dtree create-mode ${name} --yaml <file>\` instead)`);
    }
    if (other) {
      const hint = other.source === "project" ? " (omit --user)" : other.path.startsWith(userTemplatesDir()) ? " (pass --user)" : "";
      throw new DTError(`no ${source} mode ${JSON.stringify(name)} in ${dir}; it is a ${other.source} template at ${other.path}${hint}`);
    }
    throw new DTError(`mode ${JSON.stringify(name)} not found in ${dir}; run \`dtree modes\` to list them`);
  }
  for (const f of files) fs.rmSync(f, { force: true });
  const next = listTemplates(store).find((r) => r.name === name && r.active);
  return { name, source, removed: files, now_active: next ? { source: next.source, path: next.path } : null };
}

const EXAMPLE_TEMPLATE = `# Example custom decision-tree template ("mode").
#
# Copy this file to <name>.yaml, set \`name:\` to the same <name>, and edit the nodes:
#   .decisions/templates/<name>.yaml               project templates (commit them with the app)
#   ~/.config/decision-tree/templates/<name>.yaml  user templates (or a dir in $DTREE_TEMPLATES_PATH)
# Or register any file:  dtree create-mode <name> --yaml ./my-template.yaml [--user]
# Then:                  dtree new "<title>" --template <name>      (list them: dtree templates)
#
# Supported YAML: comments, key: value mappings, "- " lists, quoted strings, [a, b] lists,
# and | / > multi-line text. Anchors, aliases, tags and flow mappings are rejected.
template: 1                      # format version (required)
name: example                    # must match the file name (required)
title: Example custom template   # shown in \`dtree templates\` (required)
description: |                   # optional; the tree description when \`dtree new\` has no -d
  Replace these nodes with the questions your team always asks.
tree_status: draft               # optional: draft|active|decided|implemented|archived
nodes:                           # added under the root goal, in this order (required)
  - title: Why are we doing this, and why now?
    kind: why                    # questions: why|what|how|where|who|when|risk|other
    body: |
      What problem, for whom, and what evidence do we have?
  - title: What is in and out of scope?
    kind: what
  - title: How should we build it?
    kind: how
    children:                    # nest to any depth
      - title: Simplest thing that could work
        type: option             # question|option|decision|task|note (never goal)
        pros: [Fast to ship]
        cons: [May not scale]
  - title: Write the rollout checklist
    type: task
    assignee: agent
`;

// --------------------------------------------------------------------------- HTTP server

class App {
  constructor(projects, scanDirs = []) {
    this.fixed = projects.map((p) => path.resolve(p));
    this.scanDirs = scanDirs.map((d) => path.resolve(d));
  }

  stores() {
    const roots = [];
    for (const p of [...this.fixed, ...this.scanDirs.flatMap((d) => scanProjects(d))]) {
      if (!roots.includes(p)) roots.push(p);
    }
    return roots.map((r) => new Store(r));
  }

  store(pid) {
    const stores = this.stores();
    if (!/^\d+$/.test(pid) || Number(pid) >= stores.length) throw new DTError(`unknown project ${JSON.stringify(pid)}`);
    return stores[Number(pid)];
  }
}

function requestAuthor(body) {
  const name = String(body.author || "human").trim().slice(0, 80) || "human";
  return { name, type: choice(body.author_type || "human", AUTHOR_TYPES, "author type") };
}

function need(body, key) {
  if (body[key] === undefined || body[key] === null || body[key] === "") {
    throw new DTError(`bad request: missing ${JSON.stringify(key)}`);
  }
  return body[key];
}

function api(app, method, p, body) {
  if (method === "GET" && p.length === 1 && p[0] === "meta") return meta();
  if (method === "GET" && p.length === 1 && p[0] === "projects") {
    return app.stores().map((s, i) => ({ id: String(i), name: s.name, path: s.root, trees: s.summaries() }));
  }
  if (method === "GET" && p.length === 3 && p[0] === "projects" && p[2] === "templates") {
    return listTemplates(app.store(p[1]));
  }
  if (p.length < 3 || p[0] !== "projects" || p[2] !== "trees") throw new DTError("unknown endpoint");
  const store = app.store(p[1]);
  const rest = p.slice(3);
  if (!rest.length && method === "POST") {
    const title = String(body.title || "").trim();
    if (!title) throw new DTError("title is required");
    const slug = validateSlug(body.id || slugify(title));
    const template = body.template ? resolveTemplate(store, String(body.template), { allowPath: false }) : null;
    const description = body.description || (template ? template.description : "");
    return store.createTree(slug, title, description, requestAuthor(body), template);
  }
  if (!rest.length) throw new DTError("unknown endpoint");
  const slug = rest[0];
  if (rest.length === 1 && method === "GET") return store.load(slug);
  const author = requestAuthor(body);
  return store.edit(slug, (tree) => {
    if (rest.length === 1 && method === "PATCH") return updateTreeMeta(tree, body, author);
    if (rest.length === 2 && rest[1] === "nodes" && method === "POST") {
      addNode(tree, {
        parent: need(body, "parent"),
        type: body.type || "question",
        title: body.title || "",
        body: body.body || "",
        kind: body.kind || null,
        status: body.status || "open",
        author,
        pros: body.pros,
        cons: body.cons,
        assignee: body.assignee || "",
      });
      return tree;
    }
    if (rest.length >= 3 && rest[1] === "nodes") {
      const nid = rest[2];
      const tail = rest.slice(3).join("/");
      if (!tail && method === "PATCH") {
        if (body.parent) moveNode(tree, nid, body.parent, author);
        updateNode(tree, nid, Object.fromEntries(EDITABLE_NODE_FIELDS.map((k) => [k, body[k]])), author);
        return tree;
      }
      if (!tail && method === "DELETE") {
        deleteNode(tree, nid, author);
        return tree;
      }
      if (tail === "choose" && method === "POST") {
        chooseOption(tree, nid, body.rationale || "", author, body.reject_siblings ?? true);
        return tree;
      }
      if (tail === "comments" && method === "POST") {
        addComment(tree, nid, body.text || "", author, body.reply_to || null);
        return tree;
      }
      if (rest.length === 5 && rest[3] === "comments" && method === "PATCH") {
        resolveComment(tree, nid, rest[4], Boolean(body.resolved ?? true), author);
        return tree;
      }
      if (tail === "links" && method === "POST") {
        addLink(tree, nid, need(body, "target"), body.type || "relates-to", author);
        return tree;
      }
      if (tail === "links" && method === "DELETE") {
        removeLink(tree, nid, need(body, "target"), body.type || null, author);
        return tree;
      }
    }
    throw new DTError("unknown endpoint");
  });
}

function send(res, code, body, ctype = "application/json") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": `${ctype}; charset=utf-8`,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function allowedHost(hostHeader, boundHost) {
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || net.isIP(bare) !== 0 || (Boolean(boundHost) && hostname === boundHost);
}

/** Blocks cross-site requests and DNS rebinding: Host must be localhost/an IP/the bound host, Origin must match Host. */
function forbidden(req, boundHost) {
  const host = req.headers.host || "";
  if (!allowedHost(host, boundHost)) return `host ${JSON.stringify(host)} not allowed`;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return `cross-origin request from ${origin} rejected`;
  return null;
}

function handle(app, req, raw, res, boundHost) {
  if (process.env.DTREE_VERBOSE) console.error(`${req.method} ${req.url}`);
  const denied = forbidden(req, boundHost);
  if (denied) return send(res, 403, { error: denied });
  try {
    const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "GET" && (parts.length === 0 || (parts.length === 1 && parts[0] === "index.html"))) {
      return send(res, 200, fs.readFileSync(VIEWER_HTML), "text/html");
    }
    if (!parts.length || parts[0] !== "api") return send(res, 404, { error: "not found" });
    let body = {};
    if (["POST", "PATCH", "DELETE"].includes(req.method) && raw.length) body = JSON.parse(raw.toString("utf8"));
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new DTError("bad request: JSON body must be an object");
    }
    return send(res, 200, api(app, req.method, parts.slice(1), body));
  } catch (e) {
    if (e instanceof DTError) return send(res, 400, { error: e.message });
    if (e instanceof SyntaxError || e instanceof TypeError || e instanceof URIError) {
      return send(res, 400, { error: `bad request: ${e.message}` });
    }
    console.error(e);
    return send(res, 500, { error: "internal error" });
  }
}

function createServer(app, { host } = {}) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handle(app, req, Buffer.concat(chunks), res, host));
  });
}

// --------------------------------------------------------------------------- CLI

const USAGE = `dtree ${VERSION} - question-driven decision trees stored in .decisions/

usage: dtree <command> [options]

  init [--refresh-tool] [--templates]         create .decisions/ and vendor the tool into .decisions/_tool/
                                              (--templates: also .decisions/templates/example.yaml)
  list                                        list trees in the project
  new "<title>" [--id slug] [-d desc] [--template name|path]
                                              create a tree for a feature, optionally seeded from a template
                                              (--mode is an alias of --template)
  templates                                   list templates (project > user > built-in); alias: modes
  template show <name|path>                   print a template's outline
  template export <tree> -o <file.yaml|dir> [--name N]
                                              save a tree's structure as a reusable template
  create-mode <name> --yaml <file> [--user] [--force]
                                              validate a template and save it as .decisions/templates/<name>.yaml
                                              (--user: ~/.config/decision-tree/templates/)
  remove-mode <name> [--user]                 delete a project (or --user) template
  show <tree> [--body]                        print a tree
  node <tree> <node>                          print one node with its comment threads
  add <tree> -p <parent> [-t question|option|decision|task|note] [-k kind] --title T
      [-b body] [-s status] [--pro P]... [--con C]... [--assignee A]
  update <tree> <node> [--title T] [-b body] [-k kind] [-t type] [-s status] [--pro P]...
      [--con C]... [-r rationale] [--assignee A] [--parent new-parent]
  status <tree> <node> <status>               set node status
  choose <tree> <option> [-r rationale] [--keep-siblings]
  comment <tree> <node> "<text>" [--reply-to cID]
  resolve <tree> <node> <cID> [--reopen]
  link <tree> <src> <dst> [--type depends-on|blocks|relates-to|supersedes|duplicates]
  unlink <tree> <src> <dst>
  delete <tree> <node>                        delete a node and its subtree
  set-tree <tree> [--title T] [-d desc] [--status draft|active|decided|implemented|archived]
  inbox [tree] [--for agent|human]            items waiting on agents (default) or humans
  review <tree>                               gaps: unasked why/what/how/where, <2 options, ...
  serve [--port 8765] [--host 127.0.0.1] [--scan DIR]... [--extra-project DIR]...
  render -o out.html [--tree slug]            self-contained read-only HTML snapshot
  install-skill [--dir DIR] [--force]         copy the agent skill to DIR/decision-tree
                                              (default DIR: ./.agents/skills)

global options: -C/--project <app-root>  --author NAME  --as agent|human  --json  -h/--help  -V/--version
kinds: ${KINDS.join(" ")}
statuses: ${STATUSES.join(" ")}
env: DTREE_AUTHOR, DTREE_AUTHOR_TYPE, DTREE_VERBOSE, DTREE_TEMPLATES_PATH, XDG_CONFIG_HOME
`;

const S = { type: "string" };
const B = { type: "boolean" };
const GLOBAL_OPTS = {
  project: { ...S, short: "C" },
  author: S,
  as: S,
  json: B,
  help: { ...B, short: "h" },
  version: { ...B, short: "V" },
};
const COMMANDS = {
  init: { opts: { "refresh-tool": B, templates: B } },
  list: {},
  new: { args: ["title"], opts: { id: S, description: { ...S, short: "d" }, template: S, mode: S } },
  templates: {},
  modes: {},
  template: { args: ["action", "target?"], opts: { out: { ...S, short: "o" }, name: S } },
  "create-mode": { args: ["name"], required: ["yaml"], opts: { yaml: S, user: B, force: B } },
  "remove-mode": { args: ["name"], opts: { user: B } },
  show: { args: ["tree"], opts: { body: B } },
  node: { args: ["tree", "node"] },
  add: {
    args: ["tree"],
    required: ["parent", "title"],
    opts: {
      parent: { ...S, short: "p" },
      type: { ...S, short: "t" },
      kind: { ...S, short: "k" },
      title: S,
      body: { ...S, short: "b" },
      status: { ...S, short: "s" },
      pro: { ...S, multiple: true },
      con: { ...S, multiple: true },
      assignee: S,
    },
  },
  update: {
    args: ["tree", "node"],
    opts: {
      title: S,
      body: { ...S, short: "b" },
      kind: { ...S, short: "k" },
      type: { ...S, short: "t" },
      status: { ...S, short: "s" },
      pro: { ...S, multiple: true },
      con: { ...S, multiple: true },
      rationale: { ...S, short: "r" },
      assignee: S,
      parent: S,
    },
  },
  status: { args: ["tree", "node", "status"] },
  choose: { args: ["tree", "option"], opts: { rationale: { ...S, short: "r" }, "keep-siblings": B } },
  comment: { args: ["tree", "node", "text"], opts: { "reply-to": S } },
  resolve: { args: ["tree", "node", "comment"], opts: { reopen: B } },
  link: { args: ["tree", "src", "dst"], opts: { type: S } },
  unlink: { args: ["tree", "src", "dst"] },
  delete: { args: ["tree", "node"] },
  "set-tree": { args: ["tree"], opts: { title: S, description: { ...S, short: "d" }, status: S } },
  inbox: { args: ["tree?"], opts: { for: S } },
  review: { args: ["tree"] },
  serve: { opts: { port: S, host: S, scan: { ...S, multiple: true }, "extra-project": { ...S, multiple: true } } },
  render: { required: ["out"], opts: { out: { ...S, short: "o" }, tree: S } },
  "install-skill": { opts: { dir: S, force: B } },
};

class UsageError extends Error {}

const TEXT_OPTS = ["body", "description", "rationale"];

/** Rewrites `-b -text` as `--body=-text` so free-text values may start with "-". */
function joinTextValues(argv, opts) {
  const flags = new Map();
  for (const name of TEXT_OPTS) {
    if (!opts[name]) continue;
    flags.set(`--${name}`, name);
    if (opts[name].short) flags.set(`-${opts[name].short}`, name);
  }
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const name = flags.get(argv[i]);
    if (name && i + 1 < argv.length && argv[i + 1].startsWith("-") && argv[i + 1] !== "--") {
      out.push(`--${name}=${argv[++i]}`);
    } else out.push(argv[i]);
  }
  return out;
}

function parseCli(argv) {
  const takesValue = new Set(["-C", "--project", "--author", "--as"]);
  let idx = -1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (takesValue.has(argv[i])) i++;
    else if (!argv[i].startsWith("-")) {
      idx = i;
      break;
    }
  }
  const cmd = idx >= 0 ? argv[idx] : null;
  if (cmd !== null && !Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
    throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
  }
  const spec = cmd ? COMMANDS[cmd] : {};
  const rest = joinTextValues(idx >= 0 ? [...argv.slice(0, idx), ...argv.slice(idx + 1)] : argv, spec.opts || {});
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTS, ...(spec.opts || {}) }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const o = parsed.values;
  const opts = { cmd, help: Boolean(o.help), version: Boolean(o.version), json: Boolean(o.json), values: o };
  if (!cmd || opts.help || opts.version) return opts;
  const names = spec.args || [];
  const minArgs = names.filter((n) => !n.endsWith("?")).length;
  const pos = parsed.positionals;
  if (pos.length < minArgs) throw new UsageError(`${cmd}: missing <${names[pos.length].replace("?", "")}>`);
  if (pos.length > names.length) throw new UsageError(`${cmd}: unexpected argument ${JSON.stringify(pos[names.length])}`);
  names.forEach((n, i) => {
    opts[n.replace("?", "")] = pos[i];
  });
  for (const r of spec.required || []) if (o[r] === undefined) throw new UsageError(`${cmd}: --${r} is required`);
  if (o.as !== undefined && !AUTHOR_TYPES.includes(o.as)) throw new UsageError(`--as must be one of: ${AUTHOR_TYPES.join(", ")}`);
  if (cmd === "new" && o.template !== undefined && o.mode !== undefined) {
    throw new UsageError("new: use either --template or --mode (they are aliases), not both");
  }
  if (cmd === "template") {
    if (!["show", "export"].includes(opts.action)) throw new UsageError(`template: unknown action ${JSON.stringify(opts.action)} (use show or export)`);
    if (opts.target === undefined) throw new UsageError(`template ${opts.action}: missing <${opts.action === "show" ? "name" : "tree"}>`);
    if (opts.action === "export" && o.out === undefined) throw new UsageError("template export: -o/--out is required");
  }
  return opts;
}

function cliAuthor(o) {
  const type = o.as || process.env.DTREE_AUTHOR_TYPE || "agent";
  choice(type, AUTHOR_TYPES, "author type");
  return { name: o.author || process.env.DTREE_AUTHOR || type, type };
}

function installSkill(dir, force) {
  if (!fs.existsSync(path.join(SKILL_DIR, "SKILL.md"))) {
    throw new DTError(`SKILL.md not found next to this script; run \`npx ${PACKAGE_NAME} install-skill\` instead`);
  }
  const dest = path.join(path.resolve(dir), "decision-tree");
  if (fs.existsSync(dest)) {
    if (!force) throw new DTError(`${dest} already exists; pass --force to overwrite`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(SKILL_DIR, dest, { recursive: true });
  return dest;
}

function snapshotPayload(store, slugs) {
  const trees = Object.fromEntries(slugs.map((s) => [`0/${s}`, store.load(s)]));
  return {
    projects: [{ id: "0", name: store.name, path: store.root, trees: slugs.map((s) => summarize(trees[`0/${s}`])) }],
    trees,
    meta: meta(),
    generated_at: now(),
  };
}

/** Runs one command. Returns [data, text] for printing, or null when the command handles its own output. */
function run(a, store, author) {
  const o = a.values;
  switch (a.cmd) {
    case "init": {
      store.init(Boolean(o["refresh-tool"]), { templates: Boolean(o.templates) });
      let text = `initialized ${store.dir} (tool: ${path.join(store.dir, TOOL_DIR, SCRIPT_NAME)})`;
      const example = path.join(store.dir, TEMPLATES_DIR, "example.yaml");
      if (o.templates) text += `\nexample template: ${example}\nuse it: dtree new "<title>" --template example`;
      return [{ dir: store.dir, ...(o.templates ? { templates: path.dirname(example) } : {}) }, text];
    }
    case "list": {
      const rows = store.summaries();
      const text = rows
        .map((s) =>
          `${s.id.padEnd(32)} ${String(s.status ?? "").padEnd(12)} nodes=${String(s.node_count ?? 0).padEnd(4)} ` +
          `open_q=${String(s.open_questions ?? 0).padEnd(3)} needs_input=${String(s.needs_input ?? 0).padEnd(3)} ` +
          `waiting_on_agent=${s.waiting_on_agent ?? 0}  ${s.title}`)
        .join("\n");
      return [rows, text || `no trees in ${store.dir}`];
    }
    case "new": {
      const slug = validateSlug(o.id || slugify(a.title));
      const name = o.template ?? o.mode;
      const template = name !== undefined ? resolveTemplate(store, name) : null;
      const description = o.description ?? (template ? template.description : "");
      const tree = store.createTree(slug, a.title, description, author, template);
      const seeded = template ? ` and ${countTemplateNodes(template.nodes)} node(s) from template ${template.name}` : "";
      return [tree, `created tree ${tree.id} with root goal ${tree.root_id}${seeded} at ${store.treePath(tree.id)}`];
    }
    case "templates":
    case "modes": {
      const rows = listTemplates(store);
      const width = Math.max(4, ...rows.map((r) => r.name.length));
      const text = rows
        .map((r) => {
          const note = r.error ? `  INVALID: ${r.error}` : r.active ? "" : `  (shadowed by ${r.shadowed_by.source})`;
          return `${r.active ? "*" : " "} ${r.name.padEnd(width)}  ${r.source.padEnd(7)}  ${r.title}  ${r.path}${note}`;
        })
        .join("\n");
      const dirs = templateDirs(store).map((d) => `  ${d.source.padEnd(7)}  ${d.dir}`).join("\n");
      return [rows, (text ? `${text}\n(* = used by --template <name>)` : "no templates found") + `\nsearched:\n${dirs}`];
    }
    case "template": {
      if (a.action === "show") {
        const tpl = resolveTemplate(store, a.target);
        return [tpl, renderTemplate(tpl)];
      }
      const res = exportTemplate(store.load(a.target), o.out, o.name);
      return [res, `exported ${res.nodes} node(s) as template ${res.name} to ${res.path}\n` +
        `use it: dtree new "<title>" --template ${path.relative(process.cwd(), res.path) || res.path}` +
        ` (or copy it to .decisions/templates/ and use --template ${res.name})`];
    }
    case "create-mode": {
      const res = createMode(store, a.name, o.yaml, { user: Boolean(o.user), force: Boolean(o.force) });
      const note = res.shadows ? `\nnote: shadows the ${res.shadows.source} template at ${res.shadows.path}` : "";
      return [res, `saved ${res.source} mode ${res.name} to ${res.path}${note}\nuse it: dtree new "<title>" --mode ${res.name}`];
    }
    case "remove-mode": {
      const res = removeMode(store, a.name, { user: Boolean(o.user) });
      const note = res.now_active ? `\n${res.name} now resolves to the ${res.now_active.source} template at ${res.now_active.path}` : "";
      return [res, `removed ${res.source} mode ${res.name} (${res.removed.join(", ")})${note}`];
    }
    case "show": {
      const tree = store.load(a.tree);
      return [tree, renderText(tree, Boolean(o.body))];
    }
    case "node": {
      const node = getNode(store.load(a.tree), a.node);
      const lines = [`[${node.id}] ${node.type} ${node.kind || ""} (${node.status}) parent=${node.parent}`, node.title];
      if (node.body) lines.push("", node.body);
      for (const key of ["pros", "cons"]) if (node[key].length) lines.push(`${key}:`, ...node[key].map((x) => `  - ${x}`));
      if (node.rationale) lines.push(`rationale: ${node.rationale}`);
      if (node.links.length) lines.push("links: " + node.links.map((lk) => `${lk.type} ${lk.target}`).join(", "));
      for (const msgs of threads(node)) {
        lines.push("");
        msgs.forEach((c, i) => {
          const state = i === 0 && c.resolved ? " [resolved]" : "";
          lines.push(`${i ? "    " : ""}${c.id} ${c.author} (${c.author_type}) ${c.created_at}${state}: ${c.text}`);
        });
      }
      return [node, lines.join("\n")];
    }
    case "add":
    case "update":
    case "status":
    case "choose":
    case "comment":
    case "resolve":
    case "link":
    case "unlink":
    case "delete":
    case "set-tree":
      return store.edit(a.tree, (tree) => mutate(a, tree, author));
    case "inbox": {
      const audience = choice(o.for || "agent", AUTHOR_TYPES, "audience");
      const slugs = a.tree ? [a.tree] : store.slugs();
      const items = slugs.flatMap((slug) => inbox(store.load(slug), audience).map((it) => ({ tree: slug, ...it })));
      const lines = items.map((it) =>
        it.kind === "comment"
          ? `${it.tree} ${it.node} thread ${it.thread} — ${it.last.author} (${it.last.author_type}): ${it.last.text}`
          : `${it.tree} ${it.node} needs-input — ${it.title}`);
      return [items, lines.join("\n") || `nothing waiting on ${audience}s`];
    }
    case "review": {
      const issues = review(store.load(a.tree));
      return [issues.map(([node, issue]) => ({ node, issue })), issues.map(([n, i]) => `${n}: ${i}`).join("\n") || "no gaps found"];
    }
    case "serve": {
      const port = Number(o.port ?? 8765);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DTError(`invalid port ${JSON.stringify(o.port)}`);
      const host = o.host || "127.0.0.1";
      const scan = o.scan || [];
      if (!scan.length && !store.exists()) store.init();
      const app = new App([...(store.exists() ? [store.root] : []), ...(o["extra-project"] || [])], scan);
      const server = createServer(app, { host });
      server.on("error", (e) => {
        console.error(`error: ${e.message}`);
        process.exit(1);
      });
      server.listen(port, host, () => {
        const actual = server.address().port;
        console.log(`dtree viewer on http://${host}:${actual}  projects: ${app.stores().map((s) => s.root).join(", ")}`);
      });
      return null;
    }
    case "render": {
      const slugs = o.tree ? [o.tree] : store.slugs();
      fs.writeFileSync(o.out, renderStaticHtml(snapshotPayload(store, slugs)));
      return [{ out: o.out }, `wrote ${o.out}`];
    }
    case "install-skill": {
      const dest = installSkill(o.dir || path.join(process.cwd(), ".agents", "skills"), Boolean(o.force));
      return [{ installed: dest }, `installed skill to ${dest}`];
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(a.cmd)}`);
  }
}

function mutate(a, tree, author) {
  const o = a.values;
  switch (a.cmd) {
    case "add": {
      const res = addNode(tree, {
        parent: o.parent,
        type: o.type || "question",
        title: o.title,
        body: o.body || "",
        kind: o.kind || null,
        status: o.status || "open",
        author,
        pros: o.pro,
        cons: o.con,
        assignee: o.assignee || "",
      });
      return [res, `added ${res.id}`];
    }
    case "update": {
      if (o.parent) moveNode(tree, a.node, o.parent, author);
      const res = updateNode(tree, a.node, {
        title: o.title,
        body: o.body,
        kind: o.kind,
        type: o.type,
        status: o.status,
        pros: o.pro,
        cons: o.con,
        rationale: o.rationale,
        assignee: o.assignee,
      }, author);
      return [res, `updated ${res.id}`];
    }
    case "status": {
      const res = updateNode(tree, a.node, { status: a.status }, author);
      return [res, `${res.id} -> ${a.status}`];
    }
    case "choose": {
      const res = chooseOption(tree, a.option, o.rationale || "", author, !o["keep-siblings"]);
      return [res, `chose ${res.id} for ${res.parent}`];
    }
    case "comment": {
      const res = addComment(tree, a.node, a.text, author, o["reply-to"] || null);
      return [res, `added comment ${res.id} on ${a.node}`];
    }
    case "resolve": {
      const res = resolveComment(tree, a.node, a.comment, !o.reopen, author);
      return [res, `${o.reopen ? "reopened" : "resolved"} ${a.comment}`];
    }
    case "link": {
      const res = addLink(tree, a.src, a.dst, o.type || "depends-on", author);
      return [res, `linked ${a.src} ${res.type} ${a.dst}`];
    }
    case "unlink":
      removeLink(tree, a.src, a.dst, null, author);
      return [{}, `unlinked ${a.src} -> ${a.dst}`];
    case "delete": {
      const removed = deleteNode(tree, a.node, author);
      return [{ removed }, `deleted ${removed.join(", ")}`];
    }
    default: {
      updateTreeMeta(tree, { title: o.title, description: o.description, status: o.status }, author);
      return [summarize(tree), `updated tree ${a.tree}`];
    }
  }
}

function main(argv = process.argv.slice(2)) {
  let a;
  try {
    a = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`error: ${e.message}\nrun \`dtree --help\` for usage\n`);
    return 2;
  }
  if (a.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (a.help || !a.cmd) {
    process.stdout.write(USAGE);
    return a.cmd || a.help ? 0 : 2;
  }
  try {
    const root = a.values.project ? path.resolve(a.values.project) : findProjectRoot(process.cwd());
    const result = run(a, new Store(root), cliAuthor(a.values));
    if (result) {
      const [data, text] = result;
      process.stdout.write((a.json ? JSON.stringify(data, null, 2) : text) + "\n");
    }
    return 0;
  } catch (e) {
    if (!(e instanceof DTError) && !(e instanceof SyntaxError)) throw e;
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
}

module.exports = {
  VERSION, SCHEMA_VERSION, TEMPLATE_VERSION, NODE_TYPES, KINDS, STATUSES, TREE_STATUSES, LINK_TYPES, AUTHOR_TYPES,
  DTError, Store, App, findProjectRoot, scanProjects, slugify, validateSlug,
  addNode, updateNode, moveNode, deleteNode, chooseOption, addComment, resolveComment, addLink, removeLink,
  updateTreeMeta, threadRoot, threads, inbox, review, summarize, renderText, renderStaticHtml, snapshotPayload,
  createServer, installSkill, parseCli, main,
  parseYaml, stringifyYaml, validateTemplate, loadTemplate, resolveTemplate, listTemplates, templateDirs,
  applyTemplate, treeToTemplate, exportTemplate, renderTemplate, createMode, removeMode,
  builtinTemplatesDir, userTemplatesDir,
};

if (require.main === module) {
  const code = main();
  if (code !== 0) process.exitCode = code;
}
