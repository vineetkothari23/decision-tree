"use strict";

/**
 * Command handlers. STORE_COMMANDS get (args, store, author); TREE_EDITS get (args, tree, author) inside a
 * locked write of tree `args.tree`. Each returns [data, text] for printing, or null when it prints its own output.
 */

const fs = require("node:fs");
const path = require("node:path");
const { TOOL_DIR, SCRIPT_NAME, TEMPLATES_DIR, AUTHOR_TYPES } = require("../constants.cjs");
const { DTError, choice, hasOwn, slugify, validateSlug } = require("../util.cjs");
const { getNode, addNode, updateNode, lockNode, moveNode, deleteNode, addLink, removeLink, updateTreeMeta } = require("../core/tree.cjs");
const { chooseOption } = require("../core/choose.cjs");
const { fieldDef, readField, isBuiltinField } = require("../core/policy/fields.cjs");
const { treeConfig } = require("../config/legacy.cjs");
const { configAt, configUnder } = require("../config/scope.cjs");
const { addComment, resolveComment, threads } = require("../core/comments.cjs");
const { inbox } = require("../review/inbox.cjs");
const { review } = require("../review/checks.cjs");
const { summarize } = require("../review/summary.cjs");
const { renderText, renderTemplate, renderTreeConfig } = require("../render/text.cjs");
const { renderStaticHtml, snapshotPayload } = require("../render/static.cjs");
const { countTemplateNodes } = require("../templates/schema.cjs");
const { listTemplates, templateDirs } = require("../templates/lookup.cjs");
const { resolveTemplate, treeParent } = require("../templates/resolve.cjs");
const { exportTemplate } = require("../templates/export.cjs");
const { createMode, removeMode } = require("../templates/modes.cjs");
const { App } = require("../http/app.cjs");
const { createServer } = require("../http/server.cjs");
const { UsageError } = require("./args.cjs");
const { installSkill } = require("./install-skill.cjs");

/** `--field id=value` options as `{id: value}`; repeating a list field's option appends to it. */
function fieldOptions(cfg, specs = []) {
  const out = {};
  for (const spec of specs) {
    const at = spec.indexOf("=");
    if (at < 1) throw new DTError(`--field expects <id>=<value>, got ${JSON.stringify(spec)}`);
    const id = spec.slice(0, at);
    const value = spec.slice(at + 1);
    out[id] = fieldDef(cfg, id).type === "list" ? [...(out[id] || []), ...(value ? [value] : [])] : value;
  }
  return out;
}

function listModes(a, store) {
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

const STORE_COMMANDS = {
  init(a, store) {
    const o = a.values;
    store.init(Boolean(o["refresh-tool"]), { templates: Boolean(o.templates) });
    let text = `initialized ${store.dir} (tool: ${path.join(store.dir, TOOL_DIR, SCRIPT_NAME)})`;
    const example = path.join(store.dir, TEMPLATES_DIR, "example.yaml");
    if (o.templates) text += `\nexample template: ${example}\nuse it: dtree new "<title>" --template example`;
    return [{ dir: store.dir, ...(o.templates ? { templates: path.dirname(example) } : {}) }, text];
  },

  list(a, store) {
    const rows = store.summaries();
    const text = rows
      .map((s) =>
        `${s.id.padEnd(32)} ${String(s.status ?? "").padEnd(12)} nodes=${String(s.node_count ?? 0).padEnd(4)} ` +
        `open_q=${String(s.open_questions ?? 0).padEnd(3)} needs_input=${String(s.needs_input ?? 0).padEnd(3)} ` +
        `waiting_on_agent=${s.waiting_on_agent ?? 0}  ${s.title}`)
      .join("\n");
    return [rows, text || `no trees in ${store.dir}`];
  },

  new(a, store, author) {
    const o = a.values;
    const slug = validateSlug(o.id || slugify(a.title));
    const name = o.template ?? o.mode;
    const template = name !== undefined ? resolveTemplate(store, name) : null;
    const description = o.description ?? (template ? template.description : "");
    const tree = store.createTree(slug, a.title, description, author, template);
    const seeded = template ? ` and ${countTemplateNodes(template.nodes)} node(s) from template ${template.name}` : "";
    return [tree, `created tree ${tree.id} with root goal ${tree.root_id}${seeded} at ${store.treePath(tree.id)}`];
  },

  templates: listModes,
  modes: listModes,

  template(a, store) {
    const o = a.values;
    if (a.action === "show") {
      const tpl = resolveTemplate(store, a.target);
      return [tpl, renderTemplate(tpl)];
    }
    const tree = store.load(a.target);
    const res = exportTemplate(tree, o.out, o.name, { parentFor: (name, dir) => treeParent(store, tree, name, dir) });
    return [res, `exported ${res.nodes} node(s) as template ${res.name} to ${res.path}\n` +
      `use it: dtree new "<title>" --template ${path.relative(process.cwd(), res.path) || res.path}` +
      ` (or copy it to .decisions/templates/ and use --template ${res.name})`];
  },

  "create-mode"(a, store) {
    const o = a.values;
    const res = createMode(store, a.name, o.yaml, { user: Boolean(o.user), force: Boolean(o.force) });
    const note = res.shadows ? `\nnote: shadows the ${res.shadows.source} template at ${res.shadows.path}` : "";
    return [res, `saved ${res.source} mode ${res.name} to ${res.path}${note}\nuse it: dtree new "<title>" --mode ${res.name}`];
  },

  "remove-mode"(a, store) {
    const res = removeMode(store, a.name, { user: Boolean(a.values.user) });
    const note = res.now_active ? `\n${res.name} now resolves to the ${res.now_active.source} template at ${res.now_active.path}` : "";
    return [res, `removed ${res.source} mode ${res.name} (${res.removed.join(", ")})${note}`];
  },

  config(a, store) {
    if (a.values.mode) {
      const tpl = resolveTemplate(store, a.values.mode);
      return [tpl, renderTemplate(tpl)];
    }
    if (!a.tree) throw new UsageError("config needs a tree, or --mode <name>");
    const tree = store.load(a.tree);
    return [{ tree: tree.id, mode: tree.config ? tree.template || null : null, config: treeConfig(tree) }, renderTreeConfig(tree)];
  },

  show(a, store) {
    const tree = store.load(a.tree);
    return [tree, renderText(tree, Boolean(a.values.body))];
  },

  node(a, store) {
    const tree = store.load(a.tree);
    const node = getNode(tree, a.node);
    const lines = [`[${node.id}] ${node.type} ${node.kind || ""} (${node.status}) parent=${node.parent}`, node.title];
    if (node.body) lines.push("", node.body);
    const cfg = configAt(tree, node.id);
    for (const [id, def] of Object.entries(cfg.fields)) {
      const value = readField(node, id);
      if (id === "body" || value === undefined || !value.length) continue;
      if (def.type === "list") lines.push(`${id}:`, ...value.map((x) => `  - ${x}`));
      else lines.push(`${id}: ${value}`);
    }
    for (const [id, value] of Object.entries(node.fields || {})) if (!isBuiltinField(id) && !hasOwn(cfg.fields, id)) lines.push(`${id}: ${value}`);
    if (node.labels && node.labels.length) lines.push(`labels: ${node.labels.join(", ")}`);
    if (node.lock) lines.push(`locked: ${node.lock}`);
    if (node.links.length) lines.push("links: " + node.links.map((lk) => `${lk.type} ${lk.target}`).join(", "));
    for (const msgs of threads(node)) {
      lines.push("");
      msgs.forEach((c, i) => {
        const state = i === 0 && c.resolved ? " [resolved]" : "";
        lines.push(`${i ? "    " : ""}${c.id} ${c.author} (${c.author_type}) ${c.created_at}${state}: ${c.text}`);
      });
    }
    return [node, lines.join("\n")];
  },

  inbox(a, store) {
    const audience = choice(a.values.for || "agent", AUTHOR_TYPES, "audience");
    const slugs = a.tree ? [a.tree] : store.slugs();
    const items = slugs.flatMap((slug) => inbox(store.load(slug), audience).map((it) => ({ tree: slug, ...it })));
    const lines = items.map((it) =>
      it.kind === "comment"
        ? `${it.tree} ${it.node} thread ${it.thread} — ${it.last.author} (${it.last.author_type}): ${it.last.text}`
        : `${it.tree} ${it.node} ${it.status || "needs-input"} — ${it.title}`);
    return [items, lines.join("\n") || `nothing waiting on ${audience}s`];
  },

  review(a, store) {
    const issues = review(store.load(a.tree));
    return [issues.map(([node, issue]) => ({ node, issue })), issues.map(([n, i]) => `${n}: ${i}`).join("\n") || "no gaps found"];
  },

  serve(a, store) {
    const o = a.values;
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
  },

  render(a, store) {
    const o = a.values;
    const slugs = o.tree ? [o.tree] : store.slugs();
    fs.writeFileSync(o.out, renderStaticHtml(snapshotPayload(store, slugs)));
    return [{ out: o.out }, `wrote ${o.out}`];
  },

  "install-skill"(a) {
    const o = a.values;
    const dest = installSkill(o.dir || path.join(process.cwd(), ".agents", "skills"), Boolean(o.force));
    return [{ installed: dest }, `installed skill to ${dest}`];
  },
};

const TREE_EDITS = {
  add(a, tree, author) {
    const o = a.values;
    const res = addNode(tree, {
      parent: o.parent,
      type: o.type || "question",
      title: o.title,
      body: o.body || "",
      kind: o.kind || null,
      status: o.status || null,
      author,
      pros: o.pro,
      cons: o.con,
      assignee: o.assignee || "",
      labels: o.label,
      lock: o.lock || null,
      fields: fieldOptions(configUnder(tree, o.parent), o.field),
    });
    return [res, `added ${res.id}`];
  },

  update(a, tree, author) {
    const o = a.values;
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
      labels: o.label,
      fields: fieldOptions(configAt(tree, a.node), o.field),
    }, author);
    return [res, `updated ${res.id}`];
  },

  status(a, tree, author) {
    const res = updateNode(tree, a.node, { status: a.status }, author);
    return [res, `${res.id} -> ${a.status}`];
  },

  choose(a, tree, author) {
    const o = a.values;
    const res = chooseOption(tree, a.option, o.rationale || "", author, !o["keep-siblings"]);
    return [res, `chose ${res.id} for ${res.parent}`];
  },

  comment(a, tree, author) {
    const res = addComment(tree, a.node, a.text, author, a.values["reply-to"] || null);
    return [res, `added comment ${res.id} on ${a.node}`];
  },

  resolve(a, tree, author) {
    const reopen = Boolean(a.values.reopen);
    const res = resolveComment(tree, a.node, a.comment, !reopen, author);
    return [res, `${reopen ? "reopened" : "resolved"} ${a.comment}`];
  },

  link(a, tree, author) {
    const res = addLink(tree, a.src, a.dst, a.values.type || null, author);
    return [res, `linked ${a.src} ${res.type} ${a.dst}`];
  },

  lock(a, tree, author) {
    const res = lockNode(tree, a.node, a.values.scope || "children", author);
    return [res, `locked ${res.id} (${res.lock})`];
  },

  unlock(a, tree, author) {
    const res = lockNode(tree, a.node, null, author);
    return [res, `unlocked ${res.id}`];
  },

  unlink(a, tree, author) {
    removeLink(tree, a.src, a.dst, null, author);
    return [{}, `unlinked ${a.src} -> ${a.dst}`];
  },

  delete(a, tree, author) {
    const removed = deleteNode(tree, a.node, author);
    return [{ removed }, `deleted ${removed.join(", ")}`];
  },

  "set-tree"(a, tree, author) {
    const o = a.values;
    updateTreeMeta(tree, { title: o.title, description: o.description, status: o.status }, author);
    return [summarize(tree), `updated tree ${a.tree}`];
  },
};

/** Runs one parsed command against `store`. */
function run(a, store, author) {
  if (hasOwn(TREE_EDITS, a.cmd)) return store.edit(a.tree, (tree) => TREE_EDITS[a.cmd](a, tree, author));
  if (hasOwn(STORE_COMMANDS, a.cmd)) return STORE_COMMANDS[a.cmd](a, store, author);
  throw new UsageError(`unknown command ${JSON.stringify(a.cmd)}`);
}

module.exports = { run, STORE_COMMANDS, TREE_EDITS };
