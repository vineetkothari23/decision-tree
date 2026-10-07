"use strict";

/** Reading and writing one application's .decisions/ directory: tree files, the write lock, revisions. */

const fs = require("node:fs");
const path = require("node:path");
const {
  SCHEMA_VERSION, DECISIONS_DIR, TOOL_DIR, SCRIPT_NAME, PACKAGE_NAME, SLUG_RE, LOCK_TIMEOUT_MS, STALE_LOCK_MS, TEMPLATES_DIR,
} = require("../constants.cjs");
const { DTError, now, isDir, sleep, validateSlug } = require("../util.cjs");
const { addNode } = require("../core/tree.cjs");
const { applyTemplate } = require("../templates/apply.cjs");
const { EXAMPLE_TEMPLATE } = require("../templates/example.cjs");
const { summarize } = require("../review/summary.cjs");
const { vendorTool } = require("./vendor.cjs");

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
    vendorTool(path.join(this.dir, TOOL_DIR), refreshTool);
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

  /**
   * Creates a tree; `template` (from templates/resolve) seeds its nodes in the same locked write. A configured
   * mode's resolved config is copied into the tree, so it keeps working if the mode later changes or is removed.
   */
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
      if (template && template.resolved_config) tree.config = JSON.parse(JSON.stringify(template.resolved_config));
      const root = addNode(tree, { parent: null, type: "goal", title, body: description, author });
      tree.root_id = root.id;
      if (template) applyTemplate(tree, template, author, this);
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

module.exports = { Store };
