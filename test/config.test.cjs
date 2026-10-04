"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "skills", "decision-tree", "scripts", "dtree.cjs");
const dt = require(SCRIPT);

const AGENT = { name: "bot", type: "agent" };
const HUMAN = { name: "Vineet", type: "human" };

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dtree-config-"));

process.env.XDG_CONFIG_HOME = tmpdir();
delete process.env.DTREE_TEMPLATES_PATH;

function project(modes = {}) {
  const store = new dt.Store(tmpdir());
  store.init();
  const dir = path.join(store.dir, "templates");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(modes)) fs.writeFileSync(path.join(dir, `${name}.yaml`), text);
  return store;
}

const mode = (name, body) => `template: 1\nname: ${name}\ntitle: ${name}\n${body}${/nodes:/.test(body) ? "" : "nodes: []\n"}`;
const resolve = (store, name) => dt.resolveTemplate(store, name, { allowPath: false });
const newTree = (store, name, slug = "t") => store.createTree(slug, "T", "goal", AGENT, resolve(store, name));
const err = (fn, re) => assert.throws(fn, (e) => e instanceof dt.DTError && re.test(e.message));

function cli(cwd, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, DTREE_AUTHOR: "bot", DTREE_AUTHOR_TYPE: "" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("default mode is lean: body, relates-to, active/accepted/rejected, threads", () => {
  const cfg = resolve(project(), "default").resolved_config;
  assert.deepEqual(Object.keys(cfg.fields), ["body"]);
  assert.deepEqual(Object.keys(cfg.link_types), ["relates-to"]);
  assert.deepEqual(Object.entries(cfg.statuses).map(([k, v]) => [k, v.role]), [["active", "open"], ["accepted", "accepted"], ["rejected", "rejected"]]);
  assert.deepEqual(cfg.comments, { threads: true });
  assert.deepEqual(cfg.kinds, []);
  assert.deepEqual(cfg.labels, []);
  assert.deepEqual(cfg.review.required_kinds, []);
});

test("feature-planning extends default with planning fields, links, pending and kinds", () => {
  const tpl = resolve(project(), "feature-planning");
  const cfg = tpl.resolved_config;
  assert.deepEqual(tpl.chain, ["feature-planning", "default"]);
  assert.deepEqual(Object.keys(cfg.fields), ["body", "pros", "cons", "rationale", "assignee"]);
  assert.deepEqual(Object.keys(cfg.statuses), ["active", "accepted", "rejected", "pending"]);
  assert.equal(cfg.statuses.pending.role, "waiting");
  assert.deepEqual(Object.keys(cfg.link_types), ["relates-to", "depends-on", "blocks", "supersedes", "duplicates"]);
  assert.deepEqual(cfg.review.required_kinds, ["why", "what", "how", "where"]);
  const store = project();
  const tree = newTree(store, "feature-planning");
  assert.equal(tree.template, "feature-planning");
  assert.deepEqual(tree.config, cfg);
  assert.equal(tree.nodes.g1.status, "active");
  assert.ok(Object.values(tree.nodes).some((n) => n.status === "pending"));
  assert.equal(dt.summarize(tree).needs_input, 1);
  assert.deepEqual(dt.inbox(tree, "human").map((i) => [i.kind, i.status]), [["needs-input", "pending"]]);
});

test("inheritance: keyed merge, null removal, list replacement, no seed inheritance", () => {
  const store = project({
    base: mode("base", "extends: feature-planning\nconfig:\n  kinds: [why, how]\n  review:\n    required_kinds: [why]\n" +
      "  labels: [frontend, backend]\n  fields:\n    pros:\n      name: Upsides\n    cons: null\n    effort:\n      name: Effort\n      type: text\n" +
      "  statuses:\n    pending: null\n"),
    leaf: mode("leaf", "extends: base\nconfig:\n  labels: [api]\n  link_types:\n    blocks: null\n"),
  });
  const cfg = resolve(store, "leaf").resolved_config;
  assert.deepEqual(resolve(store, "leaf").chain, ["leaf", "base", "feature-planning", "default"]);
  assert.deepEqual(cfg.fields.pros, { name: "Upsides", type: "list" });
  assert.ok(!("cons" in cfg.fields));
  assert.deepEqual(cfg.fields.effort, { name: "Effort", type: "text" });
  assert.ok(!("pending" in cfg.statuses));
  assert.ok(!("blocks" in cfg.link_types));
  assert.deepEqual(cfg.kinds, ["why", "how"]);
  assert.deepEqual(cfg.labels, ["api"]);
  assert.equal(resolve(store, "leaf").nodes.length, 0);
});

test("inheritance errors: missing parent, cycles, depth, required roles, unknown review kinds", () => {
  err(() => resolve(project({ a: mode("a", "extends: nope\n") }), "a"), /extends: "nope" not found/);
  err(() => resolve(project({ a: mode("a", "extends: b\n"), b: mode("b", "extends: a\n") }), "a"), /inheritance cycle: a -> b -> a/);
  const chain = {};
  for (let i = 0; i < 9; i++) chain[`m${i}`] = mode(`m${i}`, `extends: ${i ? `m${i - 1}` : "default"}\n`);
  err(() => resolve(project(chain), "m8"), /more than 8 modes/);
  err(() => resolve(project({ a: mode("a", "config:\n  statuses:\n    rejected: null\n") }), "a"), /roles open, accepted, rejected \(missing: rejected\)/);
  err(() => resolve(project({ a: mode("a", "config:\n  review:\n    required_kinds: [why]\n") }), "a"), /why not in kinds/);
  err(() => resolve(project({ a: mode("a", "config:\n  fields:\n    pros:\n      type: text\n") }), "a"), /built-in field "pros" must be of type list/);
  err(() => resolve(project({ a: mode("a", "config:\n  statuses:\n    x:\n      role: maybe\n") }), "a"), /"role" must be one of/);
  err(() => resolve(project({ a: mode("a", "config:\n  labels: []\nnodes:\n  - title: Q\n    status: open\n") }), "a"), /invalid status "open"; expected one of: active, accepted, rejected/);
  err(() => dt.validateTemplate(yaml("template: 1\nname: x\ntitle: X\nnodes: []\n"), { label: "x" }), /non-empty list/);
});

const yaml = (text) => dt.parseYaml(text, "t.yaml");

test("a mode extending its own name inherits from the next one down", () => {
  const store = project({ default: mode("default", "extends: default\nconfig:\n  labels: [team]\n") });
  const cfg = resolve(store, "default").resolved_config;
  assert.deepEqual(cfg.labels, ["team"]);
  assert.deepEqual(Object.keys(cfg.statuses), ["active", "accepted", "rejected"]);
  const fp = resolve(store, "feature-planning").resolved_config;
  assert.deepEqual(fp.labels, ["team"], "built-in modes inherit the project's default");
});

test("configured trees enforce their own vocabulary; legacy trees keep the old one", () => {
  const store = project();
  const tree = newTree(store, "default");
  dt.addNode(tree, { parent: "g1", title: "Q", author: AGENT });
  assert.equal(tree.nodes.q2.status, "active");
  err(() => dt.addNode(tree, { parent: "g1", title: "Q", status: "open", author: AGENT }), /invalid status "open"/);
  err(() => dt.addNode(tree, { parent: "g1", title: "Q", kind: "why", author: AGENT }), /defines no question kinds/);
  err(() => dt.addNode(tree, { parent: "g1", type: "option", title: "O", pros: ["x"], author: AGENT }), /field "pros" is not part/);
  err(() => dt.addNode(tree, { parent: "g1", title: "Q", labels: ["x"], author: AGENT }), /defines no labels/);
  err(() => dt.updateNode(tree, "q2", { assignee: "me" }, AGENT), /field "assignee" is not editable/);
  assert.deepEqual(dt.addLink(tree, "q2", "g1", null, AGENT), { target: "g1", type: "relates-to" });
  err(() => dt.addLink(tree, "q2", "g1", "blocks", AGENT), /invalid link type/);

  const legacy = store.createTree("legacy", "L", "", AGENT);
  assert.equal(legacy.config, undefined);
  const q = dt.addNode(legacy, { parent: "g1", kind: "why", title: "Q", status: "needs-input", author: AGENT });
  assert.equal(dt.addNode(legacy, { parent: "g1", title: "Q2", author: AGENT }).status, "open");
  dt.updateNode(legacy, q.id, { pros: ["a"], assignee: "me" }, AGENT);
  assert.equal(dt.addLink(legacy, q.id, "g1", null, AGENT).type, "depends-on");
  assert.equal(dt.summarize(legacy).needs_input, 1);
});

test("custom statuses drive choose, review, inbox and summary through roles", () => {
  const store = project({
    vote: mode("vote", "extends: feature-planning\nconfig:\n  statuses:\n    active: null\n    accepted: null\n    rejected: null\n    pending: null\n" +
      "    idea:\n      role: open\n    asking:\n      role: waiting\n    stuck:\n      role: blocked\n    won:\n      role: accepted\n    lost:\n      role: rejected\n    parked:\n      role: closed\n"),
  });
  const tree = store.createTree("v", "V", "", AGENT, resolve(store, "vote"));
  const q = dt.addNode(tree, { parent: "g1", kind: "how", title: "Q", author: AGENT });
  const a = dt.addNode(tree, { parent: q.id, type: "option", title: "A", pros: ["p"], cons: ["c"], author: AGENT });
  const b = dt.addNode(tree, { parent: q.id, type: "option", title: "B", pros: ["p"], cons: ["c"], author: AGENT });
  assert.equal(q.status, "idea");
  dt.chooseOption(tree, a.id, "best", AGENT);
  assert.deepEqual([q.status, a.status, b.status, a.rationale, q.chosen], ["won", "won", "lost", "best", a.id]);
  const s = dt.summarize(tree);
  assert.equal(s.open_questions, 0);
  const q2 = dt.addNode(tree, { parent: "g1", kind: "why", title: "Ask", status: "asking", author: AGENT });
  dt.addNode(tree, { parent: "g1", kind: "what", title: "Stuck", status: "stuck", author: AGENT });
  assert.equal(dt.summarize(tree).needs_input, 1);
  assert.deepEqual(dt.inbox(tree, "human").map((i) => i.node), [q2.id]);
  const issues = dt.review(tree).map(([, i]) => i);
  assert.ok(issues.includes("blocked but no link explains why"));
  assert.ok(issues.some((i) => /no where questions/.test(i)));
  assert.ok(issues.includes("chosen option has no follow-up questions (how/where/what next?)"));
});

test("choose without a rationale field records the reason as a comment; default review skips pros/kinds", () => {
  const store = project();
  const tree = newTree(store, "default");
  const q = dt.addNode(tree, { parent: "g1", title: "Q", author: AGENT });
  const a = dt.addNode(tree, { parent: q.id, type: "option", title: "A", author: AGENT });
  dt.addNode(tree, { parent: q.id, type: "option", title: "B", author: AGENT });
  assert.deepEqual(dt.review(tree), []);
  dt.chooseOption(tree, a.id, "simplest", AGENT);
  assert.equal(a.status, "accepted");
  assert.equal(a.comments[0].text, "Chosen: simplest");
  assert.equal(q.status, "accepted");
});

test("custom fields and labels are validated and stored", () => {
  const store = project({
    m: mode("m", "config:\n  labels: [frontend, backend]\n  fields:\n    effort:\n      name: Effort\n      type: text\n    files:\n      name: Files\n      type: list\n"),
  });
  const tree = newTree(store, "m");
  const n = dt.addNode(tree, { parent: "g1", title: "Q", labels: ["frontend"], fields: { effort: " 2d ", files: "a.js\nb.js" }, author: AGENT });
  assert.deepEqual(n.fields, { effort: "2d", files: ["a.js", "b.js"] });
  assert.deepEqual(n.labels, ["frontend"]);
  dt.updateNode(tree, n.id, { effort: "3d", labels: [] }, AGENT);
  assert.equal(n.fields.effort, "3d");
  assert.equal(n.labels, undefined);
  dt.updateNode(tree, n.id, { fields: { files: [] } }, AGENT);
  assert.deepEqual(n.fields, { effort: "3d" });
  assert.ok(n.history.some((h) => h.field === "fields.effort"));
  err(() => dt.addNode(tree, { parent: "g1", title: "Q", labels: ["x"], author: AGENT }), /unknown label\(s\) x; this tree's labels are: frontend, backend/);
  err(() => dt.addNode(tree, { parent: "g1", title: "Q", fields: { effort: ["a"] }, author: AGENT }), /must be text/);
  err(() => dt.addNode(tree, { parent: "g1", title: "Q", fields: { nope: "a" }, author: AGENT }), /field "nope" is not part/);
});

test("locks block structure (children vs subtree) but not edits or comments", () => {
  const store = project();
  const tree = newTree(store, "default");
  const q = dt.addNode(tree, { parent: "g1", title: "Q", author: AGENT });
  const o = dt.addNode(tree, { parent: q.id, type: "option", title: "O", author: AGENT });
  const other = dt.addNode(tree, { parent: "g1", title: "Other", author: AGENT });
  dt.lockNode(tree, q.id, "children", AGENT);
  err(() => dt.addNode(tree, { parent: q.id, title: "X", author: AGENT }), /q2 is locked \(children\).*dtree unlock t q2/);
  err(() => dt.deleteNode(tree, o.id, AGENT), /cannot delete o3/);
  err(() => dt.moveNode(tree, other.id, q.id, AGENT), /cannot move q4 under q2/);
  err(() => dt.moveNode(tree, o.id, "g1", AGENT), /cannot move o3/);
  dt.addNode(tree, { parent: o.id, title: "Grandchild ok", author: AGENT });
  dt.updateNode(tree, o.id, { title: "Renamed", status: "rejected" }, AGENT);
  dt.addComment(tree, q.id, "still discussable", HUMAN);
  dt.lockNode(tree, q.id, "subtree", AGENT);
  err(() => dt.addNode(tree, { parent: o.id, title: "Deep", author: AGENT }), /q2 is locked \(subtree\)/);
  dt.lockNode(tree, q.id, null, AGENT);
  dt.addNode(tree, { parent: q.id, title: "Now fine", author: AGENT });
  assert.deepEqual(tree.activity.filter((x) => /lock/.test(x.action)).map((x) => [x.action, x.detail]),
    [["lock", "children"], ["lock", "subtree"], ["unlock", ""]]);
  err(() => dt.lockNode(tree, q.id, "all", AGENT), /invalid lock/);
});

test("templates seed locks after their children; pr-review locks its verdict", () => {
  const tree = newTree(project(), "pr-review");
  const verdict = Object.values(tree.nodes).find((n) => n.title === "Review verdict");
  assert.equal(verdict.lock, "children");
  assert.equal(Object.values(tree.nodes).filter((n) => n.parent === verdict.id).length, 3);
  err(() => dt.addNode(tree, { parent: verdict.id, type: "option", title: "Other", author: AGENT }), /locked/);
});

test("flat-comment modes reject replies; threaded ones keep nested replies", () => {
  const store = project({ flat: mode("flat", "config:\n  comments:\n    threads: false\n") });
  const tree = newTree(store, "flat");
  const c = dt.addComment(tree, "g1", "hi", HUMAN);
  err(() => dt.addComment(tree, "g1", "re", AGENT, c.id), /flat comments/);
  const threaded = newTree(store, "default", "t2");
  const root = dt.addComment(threaded, "g1", "hi", HUMAN);
  const r1 = dt.addComment(threaded, "g1", "re", AGENT, root.id);
  dt.addComment(threaded, "g1", "re re", HUMAN, r1.id);
  assert.equal(dt.threads(threaded.nodes.g1)[0].length, 3);
});

test("stored config is self-contained: later mode edits or removal do not change the tree", () => {
  const store = project({ m: mode("m", "config:\n  labels: [one]\n") });
  newTree(store, "m");
  fs.rmSync(path.join(store.dir, "templates", "m.yaml"));
  store.edit("t", (t) => dt.addNode(t, { parent: "g1", title: "Q", labels: ["one"], author: AGENT }));
  assert.deepEqual(store.load("t").config.labels, ["one"]);
});

test("export round-trips config, labels, locks and custom fields as a diff against the parent", () => {
  const store = project({
    m: mode("m", "extends: feature-planning\nconfig:\n  labels: [ui]\n  fields:\n    effort:\n      type: text\n" +
      "nodes:\n  - title: Q\n    kind: why\n    labels: [ui]\n    lock: subtree\n    fields:\n      effort: 1d\n    children:\n      - title: A\n        type: option\n"),
  });
  const tree = newTree(store, "m");
  const data = dt.treeToTemplate(tree, "copy", { parent: { name: "m", config: resolve(store, "m").resolved_config } });
  assert.equal(data.extends, "m");
  assert.equal(data.config, undefined);
  assert.deepEqual(data.nodes[0], { title: "Q", kind: "why", labels: ["ui"], lock: "subtree", fields: { effort: "1d" }, children: [{ title: "A", type: "option" }] });
  const res = dt.saveTreeAsMode(store, tree, "copy");
  const text = fs.readFileSync(res.path, "utf8");
  assert.match(text, /extends: m\n/);
  assert.deepEqual(resolve(store, "copy").resolved_config, tree.config);
  const again = dt.saveTreeAsMode(store, tree, "m", { force: true });
  assert.match(fs.readFileSync(again.path, "utf8"), /extends: default\n/, "saving over its own (only) source falls back to default");
  assert.deepEqual(resolve(store, "m").resolved_config, tree.config);
});

test("mode drafts: open, edit config, edit nodes, save, discard", () => {
  const store = project();
  const drafts = new dt.DraftStore(store.root);
  const d = dt.openDraft(store, drafts, { name: "team", parent: "feature-planning" }, HUMAN);
  assert.deepEqual(d.draft, { mode: "team", extends: "feature-planning" });
  assert.deepEqual(store.slugs(), [], "drafts are not trees");
  drafts.edit("team", (t) => {
    dt.setDraftConfig(store, t, { config: { ...t.config, labels: ["api"], statuses: { ...t.config.statuses, done: { name: "Done", role: "closed" } } } }, HUMAN);
    dt.addNode(t, { parent: "g1", kind: "why", title: "Why?", labels: ["api"], status: "pending", author: HUMAN });
  });
  err(() => drafts.edit("team", (t) => dt.setDraftConfig(store, t, { config: { ...t.config, labels: [] } }, HUMAN)), /q2 has label "api"/);
  const saved = dt.saveDraft(store, drafts, "team", {});
  assert.equal(saved.nodes, 1);
  const text = fs.readFileSync(saved.path, "utf8");
  assert.match(text, /extends: feature-planning\n/);
  assert.doesNotMatch(text, /pros:/, "only the diff against the parent is saved");
  const tpl = resolve(store, "team");
  assert.deepEqual(tpl.resolved_config.labels, ["api"]);
  assert.equal(tpl.nodes[0].status, "pending");
  assert.ok(!fs.existsSync(drafts.treePath("team")));
  const edit = dt.openDraft(store, drafts, { name: "team", from: "team" }, HUMAN);
  assert.equal(edit.draft.extends, "feature-planning");
  assert.equal(Object.keys(edit.nodes).length, 2);
  err(() => dt.saveDraft(store, drafts, "team", {}), /already exists/);
  dt.saveDraft(store, drafts, "team", { force: true });
});

test("CLI: config, labels, fields, locks, default link type", () => {
  const store = project({ m: mode("m", "extends: feature-planning\nconfig:\n  labels: [ui, db]\n  fields:\n    effort:\n      type: text\n") });
  const cwd = store.root;
  assert.equal(cli(cwd, "new", "Feat", "--mode", "m").code, 0);
  let r = cli(cwd, "config", "feat");
  assert.match(r.out, /mode m/);
  assert.match(r.out, /statuses: active \(open\), accepted \(accepted\), rejected \(rejected\), pending \(waiting\)/);
  assert.match(cli(cwd, "config", "--mode", "default").out, /link types: relates-to/);
  const root = cli(cwd, "--json", "add", "feat", "-p", "g1", "--title", "Q", "-k", "how", "--label", "ui", "--field", "effort=2d", "--lock", "children");
  assert.equal(root.code, 0, root.err);
  const q = JSON.parse(root.out).id;
  r = cli(cwd, "add", "feat", "-p", q, "--title", "X");
  assert.equal(r.code, 1);
  assert.match(r.err, /locked \(children\)/);
  assert.equal(cli(cwd, "unlock", "feat", q).code, 0);
  assert.equal(cli(cwd, "add", "feat", "-p", q, "-t", "option", "--title", "X", "--pro", "fast").code, 0);
  assert.equal(cli(cwd, "update", "feat", q, "--label", "ui", "--label", "db", "--field", "effort=").code, 0);
  assert.equal(cli(cwd, "lock", "feat", q, "--scope", "subtree").code, 0);
  r = cli(cwd, "node", "feat", q);
  assert.match(r.out, /labels: ui, db/);
  assert.match(r.out, /locked: subtree/);
  r = cli(cwd, "link", "feat", q, "g1");
  assert.match(r.out, /relates-to/);
  r = cli(cwd, "add", "feat", "-p", "g1", "--title", "Bad", "--label", "nope");
  assert.match(r.err, /unknown label/);
  const show = cli(cwd, "show", "feat").out;
  assert.match(show, /#ui #db; locked: subtree/);
  assert.match(cli(cwd, "--help").out, /dtree config <tree>/);
});

test("HTTP API: configured nodes, locks, drafts and meta", async (t) => {
  const store = project();
  newTree(store, "feature-planning", "fp");
  const server = dt.createServer(new dt.App([store.root]));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const meta = (await call("GET", "/api/meta")).data;
  assert.deepEqual(meta.roles, ["open", "accepted", "rejected", "waiting", "blocked", "closed"]);
  assert.deepEqual(meta.locks, ["children", "subtree"]);
  const T = "/api/projects/0/trees/fp";
  let r = await call("POST", `${T}/nodes`, { parent: "g1", title: "New", kind: "risk", assignee: "", lock: "children" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = Object.keys(r.data.nodes).pop();
  assert.equal(r.data.nodes[id].status, "active");
  assert.equal(r.data.nodes[id].lock, "children");
  r = await call("POST", `${T}/nodes`, { parent: id, title: "Blocked" });
  assert.equal(r.status, 400);
  r = await call("PATCH", `${T}/nodes/${id}`, { lock: null, status: "pending", ignored_key: 1 });
  assert.equal(r.data.nodes[id].lock, undefined);
  assert.equal(r.data.nodes[id].status, "pending");
  r = await call("POST", `${T}/nodes/${id}/links`, { target: "g1" });
  assert.deepEqual(r.data.nodes[id].links, [{ target: "g1", type: "relates-to" }]);
  r = await call("PATCH", `${T}/nodes/${id}`, { status: "open" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /invalid status/);

  r = await call("GET", "/api/projects/0/templates/feature-planning");
  assert.deepEqual(r.data.chain, ["feature-planning", "default"]);
  r = await call("POST", "/api/projects/0/drafts", { name: "mine", extends: "default" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const D = "/api/projects/0/drafts/mine";
  r = await call("PATCH", `${D}/config`, { config: { ...r.data.config, labels: ["x"] } });
  assert.deepEqual(r.data.config.labels, ["x"]);
  r = await call("POST", `${D}/nodes`, { parent: "g1", title: "Seed", labels: ["x"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call("GET", "/api/projects/0/drafts")).data[0].id, "mine");
  r = await call("POST", `${D}/save`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.nodes, 1);
  assert.equal((await call("GET", D)).status, 400);
  assert.ok((await call("GET", "/api/projects/0/templates")).data.some((m) => m.name === "mine" && m.source === "project"));
  await call("POST", "/api/projects/0/drafts", { name: "gone", extends: "default" });
  assert.equal((await call("DELETE", "/api/projects/0/drafts/gone")).status, 200);
});
