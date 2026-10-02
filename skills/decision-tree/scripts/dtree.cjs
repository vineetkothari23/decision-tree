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
const { parseArgs } = require("node:util");

const VERSION = "0.1.1";
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

  init(refreshTool = false) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tool = path.join(this.dir, TOOL_DIR);
    const here = realOrResolved(__filename);
    if (path.dirname(here) !== realOrResolved(tool) && (refreshTool || !fs.existsSync(path.join(tool, SCRIPT_NAME)))) {
      fs.mkdirSync(tool, { recursive: true });
      fs.copyFileSync(here, path.join(tool, SCRIPT_NAME));
      fs.copyFileSync(VIEWER_HTML, path.join(tool, "viewer.html"));
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

  createTree(slug, title, description, author) {
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
      const root = addNode(tree, { parent: null, type: "goal", title, body: description, author });
      tree.root_id = root.id;
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
  const c = node.comments.find((x) => x.id === cid);
  if (!c) throw new DTError(`comment ${JSON.stringify(cid)} not found on ${nid}`);
  c.resolved = resolved;
  log(tree, author, resolved ? "resolve" : "reopen", nid, cid);
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

function threads(node) {
  return node.comments
    .filter((c) => !c.reply_to)
    .map((r) => [r, ...node.comments.filter((c) => c.reply_to === r.id)]);
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
  if (p.length < 3 || p[0] !== "projects" || p[2] !== "trees") throw new DTError("unknown endpoint");
  const store = app.store(p[1]);
  const rest = p.slice(3);
  if (!rest.length && method === "POST") {
    const title = String(body.title || "").trim();
    if (!title) throw new DTError("title is required");
    const slug = validateSlug(body.id || slugify(title));
    return store.createTree(slug, title, body.description || "", requestAuthor(body));
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

function handle(app, req, raw, res) {
  if (process.env.DTREE_VERBOSE) console.error(`${req.method} ${req.url}`);
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

function createServer(app) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handle(app, req, Buffer.concat(chunks), res));
  });
}

// --------------------------------------------------------------------------- CLI

const USAGE = `dtree ${VERSION} - question-driven decision trees stored in .decisions/

usage: dtree <command> [options]

  init [--refresh-tool]                       create .decisions/ and vendor the tool into .decisions/_tool/
  list                                        list trees in the project
  new "<title>" [--id slug] [-d desc]         create a tree for a feature
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
env: DTREE_AUTHOR, DTREE_AUTHOR_TYPE, DTREE_VERBOSE
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
  init: { opts: { "refresh-tool": B } },
  list: {},
  new: { args: ["title"], opts: { id: S, description: { ...S, short: "d" } } },
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
  const rest = idx >= 0 ? [...argv.slice(0, idx), ...argv.slice(idx + 1)] : argv;
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
    case "init":
      store.init(Boolean(o["refresh-tool"]));
      return [{ dir: store.dir }, `initialized ${store.dir} (tool: ${path.join(store.dir, TOOL_DIR, SCRIPT_NAME)})`];
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
      const tree = store.createTree(validateSlug(o.id || slugify(a.title)), a.title, o.description || "", author);
      return [tree, `created tree ${tree.id} with root goal ${tree.root_id} at ${store.treePath(tree.id)}`];
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
      const server = createServer(app);
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
  VERSION, SCHEMA_VERSION, NODE_TYPES, KINDS, STATUSES, TREE_STATUSES, LINK_TYPES, AUTHOR_TYPES,
  DTError, Store, App, findProjectRoot, scanProjects, slugify, validateSlug,
  addNode, updateNode, moveNode, deleteNode, chooseOption, addComment, resolveComment, addLink, removeLink,
  updateTreeMeta, threads, inbox, review, summarize, renderText, renderStaticHtml, snapshotPayload,
  createServer, installSkill, parseCli, main,
};

if (require.main === module) {
  const code = main();
  if (code !== 0) process.exitCode = code;
}
