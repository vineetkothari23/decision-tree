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

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dtree-test-"));
}

function cli(cwd, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DTREE_AUTHOR: "bot", DTREE_AUTHOR_TYPE: "" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function sampleTree(store) {
  const tree = store.createTree("add-sso", "Add SSO", "Enterprise SSO", AGENT);
  return store.edit("add-sso", (t) => {
    dt.addNode(t, { parent: "g1", type: "question", kind: "how", title: "Which protocol?", author: AGENT });
    dt.addNode(t, { parent: "q2", type: "option", title: "SAML", pros: ["enterprise"], cons: ["xml"], author: AGENT });
    dt.addNode(t, { parent: "q2", type: "option", title: "OIDC", pros: "simple\nmodern", cons: ["some IdPs"], author: AGENT });
    return tree;
  });
}

test("package.json version matches VERSION", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.version, dt.VERSION);
  const plugin = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.version, dt.VERSION);
});

test("createTree writes a v1 tree with a root goal", () => {
  const store = new dt.Store(tmpdir());
  const tree = store.createTree("my-feature", "My feature", "desc", AGENT);
  assert.equal(tree.schema_version, 1);
  assert.equal(tree.root_id, "g1");
  assert.equal(tree.nodes.g1.type, "goal");
  assert.deepEqual(store.slugs(), ["my-feature"]);
  assert.ok(fs.existsSync(path.join(store.dir, "_tool", "dtree.cjs")));
  assert.ok(fs.existsSync(path.join(store.dir, "_tool", "viewer.html")));
  assert.throws(() => store.createTree("my-feature", "Again", "", AGENT), /already exists/);
  assert.throws(() => store.createTree("Bad Slug", "x", "", AGENT), /invalid tree slug/);
});

test("edit bumps revision and releases the lock", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  const t = store.load("add-sso");
  assert.equal(t.revision, 2);
  assert.ok(!fs.existsSync(path.join(store.dir, ".lock")));
  assert.throws(() => store.edit("add-sso", () => { throw new dt.DTError("boom"); }), /boom/);
  assert.equal(store.load("add-sso").revision, 2);
  assert.ok(!fs.existsSync(path.join(store.dir, ".lock")));
});

test("stale lock files are reclaimed", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  const lock = path.join(store.dir, ".lock");
  fs.writeFileSync(lock, "12345");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  store.edit("add-sso", (t) => dt.updateNode(t, "q2", { status: "exploring" }, AGENT));
  assert.equal(store.load("add-sso").nodes.q2.status, "exploring");
});

test("choose marks option chosen, rejects siblings, decides parent", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => dt.chooseOption(t, "o4", "modern", AGENT));
  const t = store.load("add-sso");
  assert.equal(t.nodes.o4.status, "chosen");
  assert.equal(t.nodes.o4.rationale, "modern");
  assert.deepEqual(t.nodes.o4.pros, ["simple", "modern"]);
  assert.equal(t.nodes.o3.status, "rejected");
  assert.equal(t.nodes.q2.status, "decided");
  assert.equal(t.nodes.q2.chosen, "o4");
  assert.throws(() => store.edit("add-sso", (x) => dt.chooseOption(x, "q2", "", AGENT)), /not an option/);
});

test("comments thread, resolve, and drive both inboxes", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => {
    const c = dt.addComment(t, "q2", "why not OIDC?", HUMAN);
    assert.equal(c.id, "c5");
    assert.deepEqual(dt.inbox(t, "agent").map((i) => i.thread), ["c5"]);
    dt.addComment(t, "q2", "evaluating", AGENT, "c5");
    assert.equal(dt.inbox(t, "agent").length, 0);
    assert.deepEqual(dt.inbox(t, "human").map((i) => i.thread), ["c5"]);
    dt.updateNode(t, "q2", { status: "needs-input" }, AGENT);
    assert.deepEqual(dt.inbox(t, "human").map((i) => i.kind), ["comment", "needs-input"]);
    dt.resolveComment(t, "q2", "c5", true, HUMAN);
    assert.deepEqual(dt.inbox(t, "human").map((i) => i.kind), ["needs-input"]);
    assert.throws(() => dt.addComment(t, "q2", "x", AGENT, "c999"), /not found/);
  });
});

test("links, move, delete keep the graph consistent", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => {
    dt.addNode(t, { parent: "g1", kind: "where", title: "Where?", author: AGENT });
    dt.addLink(t, "q5", "q2", "depends-on", AGENT);
    dt.addLink(t, "q5", "q2", "depends-on", AGENT);
    assert.equal(t.nodes.q5.links.length, 1);
    assert.throws(() => dt.addLink(t, "q5", "q5", "blocks", AGENT), /itself/);
    assert.throws(() => dt.moveNode(t, "q2", "o3", AGENT), /descendant/);
    dt.moveNode(t, "q5", "o3", AGENT);
    assert.equal(t.nodes.q5.parent, "o3");
    dt.addLink(t, "q2", "q5", "relates-to", AGENT);
    assert.deepEqual(dt.deleteNode(t, "o3", AGENT), ["o3", "q5"]);
    assert.deepEqual(t.nodes.q2.links, []);
    assert.throws(() => dt.deleteNode(t, "g1", AGENT), /root goal/);
  });
});

test("updateNode validates and records history", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => {
    dt.updateNode(t, "o3", { cons: ["verbose"], title: "SAML 2.0", rationale: undefined }, AGENT);
    assert.deepEqual(t.nodes.o3.history.map((h) => h.field), ["cons", "title"]);
    dt.updateNode(t, "o3", { cons: ["verbose"] }, AGENT);
    assert.equal(t.nodes.o3.history.length, 2);
    assert.throws(() => dt.updateNode(t, "o3", { status: "nope" }, AGENT), /invalid status/);
    assert.throws(() => dt.updateNode(t, "o3", { id: "x" }, AGENT), /not editable/);
  });
});

test("review flags rigor gaps", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => dt.chooseOption(t, "o4", "", AGENT));
  const issues = dt.review(store.load("add-sso")).map(([n, i]) => `${n}: ${i}`);
  assert.ok(issues.includes("g1: no why/what/where questions asked yet"));
  assert.ok(issues.includes("o4: chosen option has no rationale"));
  assert.ok(issues.some((i) => i.startsWith("o4: chosen option has no follow-up questions")));
});

test("reads trees written by the original Python implementation", () => {
  const store = new dt.Store(tmpdir());
  fs.mkdirSync(store.dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fixtures", "python-v1-tree.json"), store.treePath("add-sso-login"));
  const s = store.summaries()[0];
  assert.equal(s.id, "add-sso-login");
  assert.ok(s.node_count > 5);
  store.edit("add-sso-login", (t) => dt.addComment(t, "g1", "still works", AGENT));
  assert.match(dt.renderText(store.load("add-sso-login")), /^# /);
});

test("renderStaticHtml embeds data safely", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => dt.addComment(t, "q2", "</script><b>$& $' x", HUMAN));
  const html = dt.renderStaticHtml(dt.snapshotPayload(store, store.slugs()));
  assert.ok(html.includes("window.DTREE_STATIC = "));
  assert.ok(html.includes("<\\/script><b>$& $' x"));
  assert.ok(!html.includes("<!--DTREE_STATIC-->"));
});

test("scanProjects finds nested .decisions and skips node_modules", () => {
  const base = tmpdir();
  for (const p of ["a/.decisions", "b/c/.decisions", "node_modules/x/.decisions", ".hidden/.decisions"]) {
    fs.mkdirSync(path.join(base, p), { recursive: true });
  }
  assert.deepEqual(dt.scanProjects(base).map((p) => path.relative(base, p)).sort(), ["a", path.join("b", "c")]);
});

test("CLI end-to-end", () => {
  const dir = tmpdir();
  assert.equal(cli(dir, "init").code, 0);
  assert.match(cli(dir, "new", "Add SSO login", "-d", "desc").out, /created tree add-sso-login with root goal g1/);
  assert.match(cli(dir, "add", "add-sso-login", "-p", "g1", "-k", "how", "--title", "Protocol?").out, /added q2/);
  cli(dir, "add", "add-sso-login", "-p", "q2", "-t", "option", "--title", "SAML", "--pro", "a", "--con", "b");
  cli(dir, "add", "add-sso-login", "-p", "q2", "-t", "option", "--title", "OIDC", "--pro", "a", "--pro", "c", "--con", "b");
  assert.match(cli(dir, "choose", "add-sso-login", "o4", "-r", "simpler").out, /chose o4 for q2/);
  assert.match(cli(dir, "comment", "add-sso-login", "q2", "why?", "--as", "human", "--author", "V").out, /added comment c5/);
  assert.match(cli(dir, "inbox").out, /thread c5 — V \(human\): why\?/);
  const json = JSON.parse(cli(dir, "--json", "list").out);
  assert.equal(json[0].waiting_on_agent, 1);
  assert.equal(JSON.parse(cli(dir, "list", "--json").out)[0].id, "add-sso-login");
  const sub = path.join(dir, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  assert.match(cli(sub, "show", "add-sso-login").out, /\[o4\] option OIDC {2}\(chosen\)/);
  assert.match(cli(dir, "render", "-o", "snap.html").out, /wrote snap.html/);
  assert.ok(fs.readFileSync(path.join(dir, "snap.html"), "utf8").includes("DTREE_STATIC"));
  const vendored = spawnSync(process.execPath, [path.join(dir, ".decisions", "_tool", "dtree.cjs"), "list"], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.match(vendored.stdout, /add-sso-login/);
});

test("CLI errors and usage", () => {
  const dir = tmpdir();
  let r = cli(dir, "show", "nope");
  assert.equal(r.code, 1);
  assert.match(r.err, /error: tree "nope" not found/);
  r = cli(dir, "bogus");
  assert.equal(r.code, 2);
  r = cli(dir, "add", "t", "--title", "x");
  assert.equal(r.code, 2);
  assert.match(r.err, /--parent is required/);
  r = cli(dir, "show", "t", "--frobnicate");
  assert.equal(r.code, 2);
  assert.match(cli(dir, "--help").out, /usage: dtree <command>/);
  assert.equal(cli(dir, "--version").out.trim(), dt.VERSION);
});

test("install-skill copies SKILL.md and scripts", () => {
  const dir = tmpdir();
  const r = cli(dir, "install-skill");
  assert.equal(r.code, 0, r.err);
  const dest = path.join(dir, ".agents", "skills", "decision-tree");
  assert.ok(fs.existsSync(path.join(dest, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dest, "scripts", "dtree.cjs")));
  assert.equal(cli(dir, "install-skill").code, 1);
  assert.equal(cli(dir, "install-skill", "--force").code, 0);
  assert.equal(cli(dir, "install-skill", "--dir", "custom").code, 0);
  assert.ok(fs.existsSync(path.join(dir, "custom", "decision-tree", "SKILL.md")));
});

test("HTTP API", async (t) => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  const server = dt.createServer(new dt.App([store.root]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  assert.deepEqual((await call("GET", "/api/meta")).data.kinds, dt.KINDS);
  const projects = (await call("GET", "/api/projects")).data;
  assert.equal(projects[0].trees[0].id, "add-sso");

  const T = "/api/projects/0/trees/add-sso";
  let r = await call("POST", `${T}/nodes`, { parent: "g1", kind: "why", title: "Why?", author: "V" });
  assert.equal(r.status, 200);
  assert.equal(r.data.nodes.q5.created_by.type, "human");
  r = await call("PATCH", `${T}/nodes/q5`, { status: "needs-input", pros: "a\nb" });
  assert.equal(r.data.nodes.q5.status, "needs-input");
  r = await call("POST", `${T}/nodes/q5/comments`, { text: "hi", author: "bot", author_type: "agent" });
  assert.equal(r.data.nodes.q5.comments[0].author_type, "agent");
  r = await call("PATCH", `${T}/nodes/q5/comments/c6`, { resolved: true });
  assert.equal(r.data.nodes.q5.comments[0].resolved, true);
  r = await call("POST", `${T}/nodes/q5/links`, { target: "q2", type: "blocks" });
  assert.deepEqual(r.data.nodes.q5.links, [{ target: "q2", type: "blocks" }]);
  r = await call("DELETE", `${T}/nodes/q5/links`, { target: "q2" });
  assert.deepEqual(r.data.nodes.q5.links, []);
  r = await call("POST", `${T}/nodes/o3/choose`, { rationale: "r" });
  assert.equal(r.data.nodes.o4.status, "rejected");
  r = await call("PATCH", T, { status: "active", title: "SSO" });
  assert.equal(r.data.nodes.g1.title, "SSO");
  r = await call("DELETE", `${T}/nodes/q5`, {});
  assert.equal(r.data.nodes.q5, undefined);
  r = await call("POST", "/api/projects/0/trees", { title: "Second tree" });
  assert.equal(r.data.id, "second-tree");

  assert.equal((await call("POST", `${T}/nodes`, { title: "no parent" })).status, 400);
  assert.equal((await call("PATCH", `${T}/nodes/zzz`, { status: "open" })).status, 400);
  assert.equal((await call("GET", "/api/projects/9/trees/x")).status, 400);
  assert.equal((await call("GET", "/nope")).status, 404);
  const bad = await fetch(`${base}${T}`, { method: "PATCH", body: "{not json" });
  assert.equal(bad.status, 400);
});
