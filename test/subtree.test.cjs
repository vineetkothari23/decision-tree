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
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dtree-subtree-"));

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
const holds = (sub, extra = "") => `extends: default\nnodes:\n  - title: Sub\n    type: tree\n    mode: ${sub}\n${extra}`;
const newTree = (store, name, slug = "t") => store.createTree(slug, "T", "goal", AGENT, dt.resolveMode(store, name, { allowPath: false }));
const err = (fn, re) => assert.throws(fn, (e) => e instanceof dt.DTError && re.test(e.message));
const ofType = (tree, type) => Object.values(tree.nodes).filter((n) => n.type === type);
const under = (tree, id) => Object.values(tree.nodes).filter((n) => n.parent === id);
const VOTE = mode("vote", "config:\n  statuses:\n    accepted: null\n    rejected: null\n    picked:\n      name: Picked\n      role: accepted\n    dropped:\n      name: Dropped\n      role: rejected\n" +
  "nodes:\n  - title: Which?\n    children:\n      - title: A\n        type: option\n      - title: B\n        type: option\n");

function cli(cwd, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, DTREE_AUTHOR: "bot", DTREE_AUTHOR_TYPE: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("planning seeds a feature-planning sub-tree; statuses are valid only in their own scope", () => {
  const store = project();
  const tree = newTree(store, "planning");
  const [sub] = ofType(tree, "tree");
  assert.match(sub.id, /^s\d+$/);
  assert.equal(sub.mode, "feature-planning");
  assert.deepEqual(sub.config, dt.resolveTemplate(store, "feature-planning").resolved_config);
  assert.equal(sub.status, "active");
  const seeds = dt.resolveTemplate(store, "feature-planning").nodes;
  assert.deepEqual(under(tree, sub.id).map((n) => n.title), seeds.map((n) => n.title));
  assert.equal(dt.scopeRoot(tree, under(tree, sub.id)[0].id), sub.id);
  const inside = dt.addNode(tree, { parent: sub.id, title: "Waiting", status: "pending", author: AGENT });
  assert.equal(inside.status, "pending");
  err(() => dt.addNode(tree, { parent: sub.parent, title: "Waiting", status: "pending", author: AGENT }), /status/);
  err(() => dt.updateNode(tree, sub.id, { status: "pending" }, AGENT), /status/);
  err(() => dt.updateNode(tree, sub.id, { type: "question" }, AGENT), /cannot change s\d+ from tree/);
  err(() => dt.updateNode(tree, inside.id, { type: "tree" }, AGENT), /cannot change/);
  err(() => dt.addNode(tree, { parent: "g1", type: "tree", title: "No mode", author: AGENT }), /needs a mode/);
  assert.match(dt.renderText(tree), new RegExp(`\\[${sub.id}\\] tree:feature-planning `));
});

test("sub-trees nest: each level uses its own mode's config", () => {
  const store = project({
    outer: mode("outer", holds("mid")),
    mid: mode("mid", holds("vote")),
    vote: VOTE,
  });
  const tree = newTree(store, "outer");
  const [s1, s2] = ofType(tree, "tree");
  assert.equal(s1.mode, "mid");
  assert.equal(s2.mode, "vote");
  assert.equal(s2.parent, s1.id);
  const q = under(tree, s2.id)[0];
  assert.equal(dt.scopeRoot(tree, q.id), s2.id);
  assert.equal(dt.scopeRoot(tree, s2.id), s1.id);
  assert.ok(dt.configAt(tree, q.id).statuses.picked);
  assert.ok(!dt.configAt(tree, s2.id).statuses.picked, "the tree node itself follows its parent's scope");
  assert.equal(q.status, "active");
});

test("choose inside a sub-tree uses that scope's accepted/rejected statuses", () => {
  const store = project({ vote: VOTE });
  const tree = newTree(store, "default");
  const sub = dt.addSubtree(tree, dt.resolveSubtree(store, "vote"), { parent: "g1", title: "Vote" }, AGENT);
  const q = under(tree, sub.id)[0];
  const [a, b] = under(tree, q.id);
  dt.chooseOption(tree, a.id, "", AGENT);
  assert.equal(tree.nodes[a.id].status, "picked");
  assert.equal(tree.nodes[b.id].status, "dropped");
  assert.equal(tree.nodes[q.id].status, "picked");
  assert.equal(tree.nodes[sub.id].status, "active");
});

test("review checks required kinds per scope", () => {
  const store = project({
    bare: mode("bare", holds("feature-planning", "    children: []\n")),
  });
  const seeded = newTree(store, "planning", "seeded");
  assert.deepEqual(dt.review(seeded).filter(([, msg]) => /questions asked yet/.test(msg)), []);
  const tree = newTree(store, "bare", "bare");
  const [sub] = ofType(tree, "tree");
  assert.equal(under(tree, sub.id).length, 0, "children: [] overrides the mode's seeds");
  dt.addNode(tree, { parent: "g1", title: "Why at the top?", author: AGENT });
  const issues = dt.review(tree).filter(([, msg]) => /questions asked yet/.test(msg));
  assert.deepEqual(issues, [[sub.id, "no why/what/how/where questions asked yet"]]);
  for (const kind of ["why", "what", "how"]) dt.addNode(tree, { parent: sub.id, kind, title: kind, author: AGENT });
  assert.deepEqual(dt.review(tree).filter(([, msg]) => /questions asked yet/.test(msg)), [[sub.id, "no where questions asked yet"]]);
});

test("mode cycles and nesting deeper than 8 modes are rejected with the chain", () => {
  const store = project({
    a: mode("a", holds("b")),
    b: mode("b", holds("a")),
    self: mode("self", holds("self")),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${i + 1}`, mode(`m${i + 1}`, i < 8 ? holds(`m${i + 2}`) : "extends: default\n")])),
  });
  err(() => dt.resolveMode(store, "a"), /template "a": .*sub-tree cycle: a -> b -> a/);
  err(() => dt.resolveMode(store, "self"), /sub-tree cycle: self -> self/);
  err(() => dt.resolveMode(store, "m1"), /nest more than 8 modes deep: m1 -> m2 -> .* -> m9/);
  assert.equal(ofType(newTree(store, "m2"), "tree").length, 7);
  const file = path.join(tmpdir(), "c.yaml");
  fs.writeFileSync(file, mode("c", holds("c")));
  err(() => dt.createMode(store, "c", file), /sub-tree cycle: c -> c/);
});

test("children: overrides the mode's seeds and is validated against the sub-mode's config", () => {
  const own = "    children:\n      - title: Only this\n        status: pending\n        kind: risk\n";
  const store = project({
    ok: mode("ok", holds("feature-planning", own)),
    bad: mode("bad", holds("feature-planning", "    children:\n      - title: X\n        status: nope\n")),
  });
  const tree = newTree(store, "ok");
  const [sub] = ofType(tree, "tree");
  assert.deepEqual(under(tree, sub.id).map((n) => [n.title, n.status, n.kind]), [["Only this", "pending", "risk"]]);
  err(() => dt.resolveMode(store, "bad"), /sub-tree "feature-planning".*invalid status "nope"/);
  err(() => dt.validateTemplate({ template: 1, name: "x", title: "x", nodes: [{ title: "T", type: "tree" }] }, { label: "x", name: "x" }), /needs "mode"/);
  err(() => dt.validateTemplate({ template: 1, name: "x", title: "x", nodes: [{ title: "T", mode: "default" }] }, { label: "x", name: "x" }), /only allowed on tree nodes/);
});

test("moving across a scope boundary re-checks the moved subtree", () => {
  const store = project();
  const tree = newTree(store, "planning");
  const [sub] = ofType(tree, "tree");
  const top = sub.parent;
  const q = dt.addNode(tree, { parent: sub.id, title: "Q", kind: "risk", status: "pending", author: AGENT });
  const opt = dt.addNode(tree, { parent: q.id, type: "option", title: "O", pros: ["fast"], author: AGENT });
  err(() => dt.moveNode(tree, q.id, top, AGENT), new RegExp(`cannot move ${q.id} under ${top}: .*${q.id} has status "pending".*${opt.id} uses field "pros"`));
  assert.equal(tree.nodes[q.id].parent, sub.id);
  dt.updateNode(tree, q.id, { status: "active", kind: "" }, AGENT);
  dt.updateNode(tree, opt.id, { pros: [] }, AGENT);
  dt.moveNode(tree, q.id, top, AGENT);
  assert.equal(dt.scopeRoot(tree, q.id), tree.root_id);
  dt.moveNode(tree, sub.id, q.id, AGENT);
  assert.equal(tree.nodes[sub.id].parent, q.id, "a tree node keeps its own scope wherever it moves");
});

test("export writes tree nodes with their mode and current children; drafts keep them collapsed", () => {
  const store = project();
  const tree = newTree(store, "planning");
  const [sub] = ofType(tree, "tree");
  dt.addNode(tree, { parent: sub.id, title: "Extra", author: AGENT });
  const data = dt.treeToTemplate(tree, "copy", { parent: { name: "planning", config: tree.config } });
  const node = data.nodes[0].children[0];
  assert.equal(node.type, "tree");
  assert.equal(node.mode, "feature-planning");
  assert.deepEqual(node.children.map((n) => n.title), under(tree, sub.id).map((n) => n.title));
  dt.saveTreeAsMode(store, tree, "copy");
  const again = newTree(store, "copy", "again");
  const [sub2] = ofType(again, "tree");
  assert.deepEqual(under(again, sub2.id).map((n) => n.title), under(tree, sub.id).map((n) => n.title));
  assert.deepEqual(sub2.config, sub.config);

  const drafts = new dt.DraftStore(store.root);
  const d = dt.openDraft(store, drafts, { name: "plan2", from: "planning" }, AGENT);
  const [ds] = ofType(d, "tree");
  assert.equal(ds.mode, "feature-planning");
  assert.equal(under(d, ds.id).length, 0, "mode drafts reference sub-modes instead of copying their seeds");
  const saved = dt.saveDraft(store, drafts, "plan2", {});
  const text = fs.readFileSync(saved.path, "utf8");
  assert.match(text, /type: tree\n\s+mode: feature-planning\n/);
  assert.equal(dt.resolveTemplate(store, "plan2").nodes[0].children[0].children, null);
});

test("legacy trees without config are unchanged and can hold sub-trees", () => {
  const store = project();
  const tree = store.createTree("legacy", "L", "", AGENT, null);
  assert.equal(tree.config, undefined);
  const q = dt.addNode(tree, { parent: "g1", title: "Q", status: "needs-input", author: AGENT });
  const sub = dt.addSubtree(tree, dt.resolveSubtree(store, "feature-planning"), { parent: q.id, title: "F", status: "exploring" }, AGENT);
  assert.equal(sub.status, "exploring");
  assert.ok(under(tree, sub.id).length > 0);
  assert.equal(dt.configAt(tree, q.id), dt.LEGACY_CONFIG);
  err(() => dt.addNode(tree, { parent: sub.id, title: "X", status: "needs-input", author: AGENT }), /status/);
  assert.equal(tree.config, undefined);
});

test("CLI and HTTP API add tree nodes with --mode / mode", async (t) => {
  const store = project();
  const cwd = store.root;
  assert.equal(cli(cwd, "new", "Plan").code, 0);
  let r = cli(cwd, "--json", "add", "plan", "-p", "g1", "-t", "tree", "--mode", "feature-planning", "--title", "Feature: X");
  assert.equal(r.code, 0, r.err);
  const sid = JSON.parse(r.out).id;
  assert.match(sid, /^s/);
  assert.match(cli(cwd, "add", "plan", "-p", "g1", "--mode", "feature-planning", "--title", "F2").out, /added s\d+ \(mode feature-planning, \d+ node\(s\)\)/);
  assert.match(cli(cwd, "add", "plan", "-p", "g1", "-t", "option", "--mode", "default", "--title", "X").err, /--mode only applies to tree nodes/);
  assert.match(cli(cwd, "add", "plan", "-p", "g1", "-t", "tree", "--title", "X").err, /needs a mode/);
  assert.match(cli(cwd, "node", "plan", sid).out, /mode: feature-planning/);
  assert.match(cli(cwd, "show", "plan").out, /tree:feature-planning Feature: X/);
  assert.doesNotMatch(cli(cwd, "review", "plan").out, /^s\d+: no /m, "seeded sub-trees ask their own required kinds");

  const server = dt.createServer(new dt.App([store.root]));
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/projects/0`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  r = await call("POST", "/trees/plan/nodes", { parent: "g1", type: "tree", mode: "feature-planning", title: "Feature: Y" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const y = Object.values(r.data.nodes).find((n) => n.title === "Feature: Y");
  assert.equal(y.mode, "feature-planning");
  assert.ok(Object.values(r.data.nodes).some((n) => n.parent === y.id));
  assert.equal((await call("POST", "/trees/plan/nodes", { parent: "g1", type: "tree", title: "No mode" })).status, 400);
  r = await call("POST", "/trees", { title: "Big", template: "planning" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Object.values(r.data.nodes).some((n) => n.type === "tree" && Object.values(r.data.nodes).some((m) => m.parent === n.id)));
  await call("POST", "/drafts", { name: "pl", from: "default" });
  r = await call("POST", "/drafts/pl/nodes", { parent: "g1", type: "tree", mode: "feature-planning", title: "F" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = Object.values(r.data.nodes).find((n) => n.type === "tree");
  assert.ok(!Object.values(r.data.nodes).some((n) => n.parent === f.id), "drafts don't copy sub-mode seeds");
});
