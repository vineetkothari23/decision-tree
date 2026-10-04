"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
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

test("replies to replies stay in their root thread", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => {
    dt.addComment(t, "q2", "Which IdPs?", AGENT);
    dt.addComment(t, "q2", "Okta and Azure AD", HUMAN, "c5");
    dt.addComment(t, "q2", "Thanks, OIDC then", AGENT, "c6");
    assert.deepEqual(dt.threads(t.nodes.q2).map((th) => th.map((c) => c.id)), [["c5", "c6", "c7"]]);
    assert.equal(dt.inbox(t, "agent").length, 0);
    assert.deepEqual(dt.inbox(t, "human").map((i) => i.thread), ["c5"]);
    assert.equal(dt.review(t).some(([, issue]) => /unanswered/.test(issue)), false);
    dt.resolveComment(t, "q2", "c7", true, HUMAN);
    assert.equal(t.nodes.q2.comments[0].resolved, true);
    assert.equal(dt.inbox(t, "human").length, 0);
  });
  const dir = store.root;
  const out = cli(dir, "node", "add-sso", "q2").out;
  assert.match(out, /c7 bot \(agent\).*Thanks, OIDC then/);
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

test("HTTP API rejects cross-origin and foreign-host requests", async (t) => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  const server = dt.createServer(new dt.App([store.root]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const send = (headers, method = "POST", p = "/api/projects/0/trees/add-sso/nodes/q2/comments") =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(method === "GET" ? undefined : JSON.stringify({ text: "hi" }));
    });
  const text = { "Content-Type": "text/plain" };
  assert.equal(await send({ ...text, Origin: "https://evil.example" }), 403);
  assert.equal(await send({ ...text, Host: `attacker.example:${port}` }), 403);
  assert.equal(await send({ Host: `attacker.example:${port}` }, "GET", "/api/projects"), 403);
  assert.equal(await send({ Origin: "null" }), 403);
  assert.equal(store.load("add-sso").nodes.q2.comments.length, 0);
  assert.equal(await send({ Origin: `http://127.0.0.1:${port}` }), 200);
  assert.equal(await send({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 200);
  assert.equal(await send({}), 200);
  assert.equal(store.load("add-sso").nodes.q2.comments.length, 3);

  const lan = dt.createServer(new dt.App([store.root]), { host: "devbox.local" });
  await new Promise((resolve) => lan.listen(0, "127.0.0.1", resolve));
  t.after(() => lan.close());
  const lanPort = lan.address().port;
  const status = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: lanPort, path: "/api/projects", headers: { Host: `devbox.local:${lanPort}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(status, 200);
});

// --------------------------------------------------------------------------- YAML + templates

function cliEnv(cwd, env, ...args) {
  const r = spawnSync(process.execPath, [args[0], ...args.slice(1)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DTREE_AUTHOR: "bot", DTREE_AUTHOR_TYPE: "", DTREE_TEMPLATES_PATH: "", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function tplText(name, title = `Template ${name}`, extra = "") {
  return `template: 1\nname: ${name}\ntitle: ${title}\n${extra}nodes:\n  - title: First question\n    kind: why\n`;
}

/** Runs `fn` with template env vars pointed at fresh dirs (nothing from the real user config). */
function withTemplateEnv(env, fn) {
  const keys = ["DTREE_TEMPLATES_PATH", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const yaml = (text) => dt.parseYaml(text, "t.yaml");
const yamlErr = (text, re) => assert.throws(() => yaml(text), (e) => e instanceof dt.DTError && re.test(e.message));

test("YAML parser: supported constructs", () => {
  assert.deepEqual(
    yaml("# full-line comment\n\na: 1   # trailing comment\nb: plain string here\nc: 'single # not comment'\n" +
      "d: \"dq \\\"x\\\" \\\\ \\t tab\\nline\"\ne: -42\nf: true\ng: false\nh: null\ni: ~\nj:\nk: it''s\nl: 'it''s'\n" +
      "m: a#b\nn: http://x.y/z\n"),
    { a: 1, b: "plain string here", c: "single # not comment", d: 'dq "x" \\ \t tab\nline', e: -42, f: true, g: false,
      h: null, i: null, j: null, k: "it''s", l: "it's", m: "a#b", n: "http://x.y/z" },
  );
  assert.deepEqual(yaml("a:\n  b:\n    c: 1\n  d: x\ne: 2\n"), { a: { b: { c: 1 }, d: "x" }, e: 2 });
  assert.deepEqual(yaml("- a\n- 2\n-\n- - x\n  - y\n"), ["a", 2, null, ["x", "y"]]);
  assert.deepEqual(yaml("list:\n- a\n- b\nnext: 1\n"), { list: ["a", "b"], next: 1 });
  assert.deepEqual(yaml("nodes:\n  - title: A\n    kind: why\n    children:\n      - title: B\n  - title: C\n"), {
    nodes: [{ title: "A", kind: "why", children: [{ title: "B" }] }, { title: "C" }],
  });
  assert.deepEqual(yaml('f: [a, "b, c", \'d\', 3, true, null]\ng: []\nh: {}\ni: [ ]\nj: [x,]  # c\n'), {
    f: ["a", "b, c", "d", 3, true, null], g: [], h: {}, i: [], j: ["x"],
  });
  assert.deepEqual(yaml("lit: |\n  one\n    two\n\n  three\n\n\nnext: x\n"), { lit: "one\n  two\n\nthree\n", next: "x" });
  assert.deepEqual(yaml("a: |-\n  x\n  y\n\nb: |+\n  x\n\n\nc: x\n"), { a: "x\ny", b: "x\n\n\n", c: "x" });
  assert.deepEqual(yaml("a: >\n  one\n  two\n\n  three\n    more\nb: >-\n  x\n  y\nc: >+\n  z\n\n"), {
    a: "one two\nthree\n  more\n", b: "x y", c: "z\n\n",
  });
  assert.deepEqual(yaml("a: |  # comment\n  # not a comment\n  - dash first\nb: |\n"), { a: "# not a comment\n- dash first\n", b: "" });
  assert.deepEqual(yaml("- |\n  block in list\n- k: >-\n    folded\n"), ["block in list\n", { k: "folded" }]);
  assert.deepEqual(yaml("---\na: 1\n"), { a: 1 });
  assert.deepEqual(yaml("\"quoted key\": 1\n'k2': 2\n"), { "quoted key": 1, k2: 2 });
  assert.equal(yaml("# only comments\n\n"), null);
  assert.deepEqual(yaml("a: 1\r\nb: 2\r\n"), { a: 1, b: 2 });
  assert.deepEqual(yaml("__proto__: x\n"), JSON.parse('{"__proto__":"x"}'));
});

test("YAML parser: rejects unsupported syntax with file:line", () => {
  yamlErr("a: &anchor 1\n", /t\.yaml:1: anchors/);
  yamlErr("a: 1\nb: *ref\n", /t\.yaml:2: aliases/);
  yamlErr("a: !!str 1\n", /t\.yaml:1: tags/);
  yamlErr("a: 1\n---\nb: 2\n", /t\.yaml:2: multiple documents/);
  yamlErr("a: 1\n...\n", /t\.yaml:2: document end/);
  yamlErr("a: {b: 1}\n", /t\.yaml:1: flow mappings/);
  yamlErr("? complex\n: v\n", /t\.yaml:1: complex keys/);
  yamlErr("a:\n\tb: 1\n", /t\.yaml:2: tabs/);
  yamlErr("- \tx\n", /t\.yaml:1: tabs/);
  yamlErr("a: [1, [2]]\n", /t\.yaml:1: nested flow/);
  yamlErr("a: [1, 2\n", /t\.yaml:1: .*flow sequence/);
  yamlErr("a: [x: 1]\n", /t\.yaml:1: mappings inside flow/);
  yamlErr('a: "open\n', /t\.yaml:1: unterminated/);
  yamlErr('a: "bad \\q"\n', /t\.yaml:1: unsupported escape/);
  yamlErr("a: 1\na: 2\n", /t\.yaml:2: duplicate key/);
  yamlErr("a: 1\n   b: 2\n", /t\.yaml:2: unexpected indentation/);
  yamlErr("a: one\n  two\n", /t\.yaml:2: unexpected indentation/);
  yamlErr("a: b: c\n", /t\.yaml:1: .*quote/);
  yamlErr("a: |2\n  x\n", /t\.yaml:1: unsupported block scalar header/);
  yamlErr("a: 1\n- b\n", /t\.yaml:2: unexpected list item/);
  yamlErr("%YAML 1.2\na: 1\n", /t\.yaml:1: YAML directives/);
  yamlErr("a: 'x' y\n", /t\.yaml:1: unexpected text after value/);
});

test("YAML emitter round-trips through the parser", () => {
  const values = [
    { a: "plain", b: "", c: " lead", d: "x: y", e: "#hash", f: "- dash", g: "true", h: "12", i: "null", j: "it's", k: 'q"q' },
    { multi: "line one\n  indented\nlast\n", strip: "no newline\nat end", keep: "two\n\n", dash: "- a\n- b\n" },
    { tabs: "a\tb\nc", blankline: "a\n\nb\n", lead: "  leading\nspace\n", ctrl: "bell\u0007" },
    { list: ["a", "b, c", "", "[x]", "y: z", 3, true, null], empty: [], obj: {}, nested: [{ t: "x", c: [{ t: "y" }] }, ["p", "q"]] },
    { "key with space": 1, "-dash": 2, "1": 3 },
  ];
  for (const v of values) assert.deepEqual(yaml(dt.stringifyYaml(v)), v);
  assert.equal(dt.stringifyYaml({ a: "x\ny\n" }), "a: |\n  x\n  y\n");
});

test("template validation errors name the template and node path", () => {
  const v = (data) => dt.validateTemplate(data, { label: '"t"', name: "t" });
  const base = { template: 1, name: "t", title: "T", nodes: [{ title: "Q" }] };
  const err = (data, re) => assert.throws(() => v(data), (e) => e instanceof dt.DTError && /^template "t": /.test(e.message) && re.test(e.message));
  const ok = v({ ...base, description: "d\n", tree_status: "active",
    nodes: [{ title: "Q", body: "b\n", children: [{ title: "O", type: "option", pros: ["p"], cons: "c", status: "chosen", assignee: "me" }] }] });
  assert.equal(ok.description, "d");
  assert.equal(ok.tree_status, "active");
  assert.deepEqual(ok.nodes[0], {
    title: "Q", type: "question", kind: null, body: "b", status: "open", assignee: "", pros: [], cons: [],
    children: [{ title: "O", type: "option", kind: null, body: "", status: "chosen", assignee: "me", pros: ["p"], cons: ["c"], children: [] }],
  });
  err(null, /must be a mapping/);
  err({ ...base, extra: 1 }, /unknown key "extra"/);
  err({ ...base, template: undefined }, /missing required key "template"/);
  err({ ...base, template: 2 }, /unsupported format version 2/);
  err({ ...base, name: undefined }, /missing required key "name"/);
  err({ ...base, name: "Bad Name" }, /invalid name/);
  err({ ...base, name: "other" }, /must match the file name "t"/);
  err({ ...base, title: undefined }, /missing required key "title"/);
  err({ ...base, tree_status: "nope" }, /tree_status: invalid tree status/);
  err({ ...base, nodes: [] }, /nodes: must be a non-empty list/);
  err({ ...base, nodes: undefined }, /nodes: must be a non-empty list/);
  err({ ...base, nodes: "x" }, /nodes: must be a list/);
  err({ ...base, nodes: [{ title: "a" }, { title: "b" }, { title: "c", children: [null] }] }, /nodes\[2\]\.children\[0\]: must be a mapping/);
  err({ ...base, nodes: [{ title: "a" }, { title: "b" }, { title: "c", children: [{ body: "x" }] }] }, /nodes\[2\]\.children\[0\]: missing required "title"/);
  err({ ...base, nodes: [{ title: " " }] }, /nodes\[0\]: missing required "title"/);
  err({ ...base, nodes: [{}] }, /nodes\[0\]: must be a mapping|nodes\[0\]: missing required "title"/);
  err({ ...base, nodes: [{ title: "x", type: "goal" }] }, /nodes\[0\]: type "goal" is reserved/);
  err({ ...base, nodes: [{ title: "x", type: "epic" }] }, /nodes\[0\]: invalid type "epic"/);
  err({ ...base, nodes: [{ title: "x", kind: "huh" }] }, /nodes\[0\]: invalid kind "huh"/);
  err({ ...base, nodes: [{ title: "x", type: "task", kind: "why" }] }, /nodes\[0\]: "kind" is only allowed on questions/);
  err({ ...base, nodes: [{ title: "x", status: "maybe" }] }, /nodes\[0\]: invalid status "maybe"/);
  err({ ...base, nodes: [{ title: "x", pros: ["p"] }] }, /nodes\[0\]: "pros" is only allowed on options/);
  err({ ...base, nodes: [{ title: "x", children: [{ title: "y", colour: "red" }] }] }, /nodes\[0\]\.children\[0\]: unknown key "colour"/);
  err({ ...base, nodes: [{ title: "x", children: "y" }] }, /nodes\[0\]\.children: must be a list/);
  err({ ...base, nodes: [{ title: { a: 1 } }] }, /nodes\[0\]: "title" must be a string/);
  const dir = tmpdir();
  const file = path.join(dir, "named.yaml");
  fs.writeFileSync(file, "template: 1\nname: named\ntitle: T\nnodes:\n  - title: a\n  - kind: why\n");
  assert.throws(() => dt.loadTemplate(file), /template "named" \(.*named\.yaml\): nodes\[1\]: missing required "title"/);
  fs.writeFileSync(file, "template: 1\nname: named\ntitle: T\nnodes: &x\n");
  assert.throws(() => dt.loadTemplate(file), /named\.yaml:4: anchors/);
  fs.writeFileSync(path.join(dir, "j.json"), '{"template": 1, "name": "j", "title": "J", "nodes": [{"title": "q"}]}');
  assert.equal(dt.loadTemplate(path.join(dir, "j.json")).nodes[0].title, "q");
  fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.throws(() => dt.loadTemplate(path.join(dir, "bad.json")), /bad\.json: invalid JSON/);
});

test("template lookup precedence: path > project > DTREE_TEMPLATES_PATH > user config > builtin", () => {
  const app = tmpdir();
  const store = new dt.Store(app);
  const envDir1 = tmpdir();
  const envDir2 = tmpdir();
  const xdg = tmpdir();
  const userDir = path.join(xdg, "decision-tree", "templates");
  const projDir = path.join(store.dir, "templates");
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const put = (dir, name, title) => fs.writeFileSync(path.join(dir, `${name}.yaml`), tplText(name, title));
  for (const [dir, label] of [[projDir, "project"], [envDir1, "env1"], [envDir2, "env2"], [userDir, "xdg"]]) put(dir, "shared", label);
  put(envDir1, "env-only", "env1");
  put(envDir2, "env-only", "env2");
  put(envDir2, "env2-only", "env2");
  put(userDir, "xdg-only", "xdg");
  fs.writeFileSync(path.join(envDir1, "broken.yaml"), "template: 1\nname: other\n");
  fs.writeFileSync(path.join(projDir, "notes.txt"), "ignored");
  const env = { DTREE_TEMPLATES_PATH: [envDir1, envDir2].join(path.delimiter), XDG_CONFIG_HOME: xdg };
  withTemplateEnv(env, () => {
    assert.equal(dt.resolveTemplate(store, "shared").title, "project");
    assert.equal(dt.resolveTemplate(store, "shared").source, "project");
    assert.equal(dt.resolveTemplate(store, "env-only").title, "env1");
    assert.equal(dt.resolveTemplate(store, "env2-only").source, "user");
    assert.equal(dt.resolveTemplate(store, "xdg-only").title, "xdg");
    const pathTpl = dt.resolveTemplate(store, path.join(envDir2, "shared.yaml"));
    assert.equal(pathTpl.title, "env2");
    assert.equal(pathTpl.source, "path");
    assert.throws(() => dt.resolveTemplate(store, "missing"), /template "missing" not found/);
    assert.throws(() => dt.resolveTemplate(store, "../x"), /not found/);
    assert.throws(() => dt.resolveTemplate(store, "Bad Name"), /invalid template name/);
    assert.throws(() => dt.resolveTemplate(store, "./x.yaml", { allowPath: false }), /must be a name, not a path/);
    assert.throws(() => dt.resolveTemplate(store, "broken"), /must match the file name/);
    const rows = dt.listTemplates(store);
    const shared = rows.filter((r) => r.name === "shared");
    assert.deepEqual(shared.map((r) => [r.title, r.active]), [["project", true], ["env1", false], ["env2", false], ["xdg", false]]);
    assert.equal(shared[1].shadowed_by.source, "project");
    assert.match(rows.find((r) => r.name === "broken").error, /must match the file name/);
    assert.ok(!rows.some((r) => r.name === "notes"));
    assert.deepEqual(dt.templateDirs(store).map((d) => d.source), ["project", "user", "user", "user", "builtin"]);
  });
  withTemplateEnv({ XDG_CONFIG_HOME: xdg }, () => {
    assert.throws(() => dt.resolveTemplate(store, "env-only"), /not found/, "env dirs only apply when set");
    assert.equal(dt.resolveTemplate(store, "xdg-only").source, "user");
  });
});

test("built-in templates resolve next to the script and are vendored by init", () => {
  const skill = path.join(tmpdir(), "skills", "decision-tree");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skill, "templates"));
  const script = path.join(skill, "scripts", "dtree.cjs");
  fs.copyFileSync(SCRIPT, script);
  fs.copyFileSync(path.join(path.dirname(SCRIPT), "viewer.html"), path.join(skill, "scripts", "viewer.html"));
  fs.cpSync(path.join(path.dirname(SCRIPT), "lib"), path.join(skill, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(skill, "templates", "shipped.yaml"), tplText("shipped", "Builtin one"));
  fs.writeFileSync(path.join(skill, "templates", "shadowed.yaml"), tplText("shadowed", "Builtin two"));
  const app = tmpdir();
  const env = { XDG_CONFIG_HOME: tmpdir() };
  assert.equal(cliEnv(app, env, script, "init", "--templates").code, 0);
  fs.writeFileSync(path.join(app, ".decisions", "templates", "shadowed.yaml"), tplText("shadowed", "Project two"));
  let r = cliEnv(app, env, script, "templates", "--json");
  assert.equal(r.code, 0, r.err);
  const rows = JSON.parse(r.out);
  assert.deepEqual(rows.map((x) => [x.name, x.source, x.active]), [
    ["example", "project", true], ["shadowed", "project", true], ["shadowed", "builtin", false], ["shipped", "builtin", true],
  ]);
  r = cliEnv(app, env, script, "templates");
  assert.match(r.out, /\* shipped\s+builtin\s+Builtin one/);
  assert.match(r.out, / {2}shadowed\s+builtin\s+Builtin two .*\(shadowed by project\)/);
  const vendored = path.join(app, ".decisions", "_tool", "dtree.cjs");
  assert.ok(fs.existsSync(path.join(app, ".decisions", "_tool", "templates", "shipped.yaml")));
  r = cliEnv(app, env, vendored, "new", "From builtin", "--template", "shipped");
  assert.equal(r.code, 0, r.err);
  const tree = JSON.parse(fs.readFileSync(path.join(app, ".decisions", "from-builtin.json"), "utf8"));
  assert.equal(tree.template, "shipped");
  assert.equal(tree.nodes.q2.title, "First question");
});

test("built-in templates shipped with the skill parse and validate", () => {
  const dir = dt.builtinTemplatesDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)) : [];
  for (const f of files) {
    const loaded = dt.loadTemplate(path.join(dir, f), "builtin");
    assert.ok(loaded.nodes.length > 0 || loaded.config, f);
    const store = new dt.Store(tmpdir());
    const tpl = dt.resolveTemplate(store, loaded.name, { allowPath: false });
    const tree = store.createTree("t", "T", "", AGENT, tpl);
    assert.equal(tree.template, tpl.name);
  }
});

test("createTree seeds template nodes in order, nested, in one write", () => {
  const store = new dt.Store(tmpdir());
  const tpl = dt.validateTemplate(yaml(
    "template: 1\nname: seed\ntitle: Seed\ndescription: |\n  Template desc\ntree_status: active\nnodes:\n" +
    "  - title: Why?\n    kind: why\n    body: |\n      - starts with a dash\n" +
    "    children:\n      - title: Option A\n        type: option\n        pros: [fast]\n        cons: [risky, \"x, y\"]\n" +
    "        children:\n          - title: Deep note\n            type: note\n" +
    "  - title: Who decides?\n    kind: who\n    status: needs-input\n    assignee: human\n  - title: Ship it\n    type: task\n"), { label: "seed", name: "seed" });
  const tree = store.createTree("seeded", "Seeded", "", AGENT, { ...tpl, source: "project" });
  assert.equal(tree.revision, 1);
  assert.equal(tree.status, "active");
  assert.equal(tree.template, "seed");
  assert.deepEqual(Object.keys(tree.nodes), ["g1", "q2", "o3", "n4", "q5", "t6"]);
  assert.deepEqual(Object.values(tree.nodes).map((n) => n.parent), [null, "g1", "q2", "o3", "g1", "g1"]);
  assert.equal(tree.nodes.q2.body, "- starts with a dash");
  assert.deepEqual(tree.nodes.o3.cons, ["risky", "x, y"]);
  assert.equal(tree.nodes.q5.status, "needs-input");
  assert.equal(tree.nodes.q5.assignee, "human");
  const entry = tree.activity.find((a) => a.action === "template");
  assert.match(entry.detail, /^seed \(project\): 5 node\(s\)/);
  assert.deepEqual(store.load("seeded"), tree);
  assert.equal(dt.summarize(tree).template, "seed");
  assert.equal(dt.summarize(store.createTree("plain", "Plain", "", AGENT)).template, null);
  assert.equal(store.load("plain").template, undefined);
});

test("export -> reimport round trip keeps structure but not status/comments", () => {
  const store = new dt.Store(tmpdir());
  sampleTree(store);
  store.edit("add-sso", (t) => {
    dt.addNode(t, { parent: "g1", type: "task", title: "Migrate users", body: "- step one\n- step two\n\n  indented", author: AGENT });
    dt.addComment(t, "q2", "what about LDAP?", HUMAN);
    dt.chooseOption(t, "o3", "enterprise", AGENT);
  });
  const out = path.join(tmpdir(), "sso-flow.yaml");
  const res = dt.exportTemplate(store.load("add-sso"), out);
  assert.deepEqual(res, { name: "sso-flow", path: out, nodes: 4 });
  const text = fs.readFileSync(out, "utf8");
  assert.doesNotMatch(text, /status|LDAP|rationale|comment/);
  const tpl = dt.loadTemplate(out);
  assert.equal(tpl.title, "Add SSO");
  assert.equal(tpl.description, "Enterprise SSO");
  assert.deepEqual(tpl.nodes.map((n) => [n.type, n.kind, n.title]), [["question", "how", "Which protocol?"], ["task", null, "Migrate users"]]);
  assert.deepEqual(tpl.nodes[0].children.map((n) => [n.title, n.status, n.pros, n.cons]), [
    ["SAML", "open", ["enterprise"], ["xml"]], ["OIDC", "open", ["simple", "modern"], ["some IdPs"]],
  ]);
  assert.equal(tpl.nodes[1].body, "- step one\n- step two\n\n  indented");
  const again = store.createTree("again", "Again", "", AGENT, tpl);
  const shape = (t) => Object.values(t.nodes).filter((n) => n.parent).map((n) => [n.type, n.kind, n.title, n.body, n.pros, n.cons]);
  const orig = store.load("add-sso");
  assert.deepEqual(shape(again), shape(orig));
  assert.deepEqual(dt.treeToTemplate(again, "sso-flow").nodes, dt.treeToTemplate(orig, "sso-flow").nodes);
  const dirOut = tmpdir();
  assert.equal(dt.exportTemplate(orig, dirOut + path.sep, "named").path, path.join(dirOut, "named.yaml"));
  assert.equal(dt.loadTemplate(dt.exportTemplate(orig, path.join(dirOut, "j.json")).path).name, "j");
  assert.throws(() => dt.exportTemplate(orig, path.join(dirOut, "x.yaml"), "other"), /must match the output file name/);
  assert.throws(() => dt.exportTemplate(orig, path.join(dirOut, "x.txt")), /must end in \.yaml/);
  assert.throws(() => dt.exportTemplate(store.createTree("empty", "E", "", AGENT), path.join(dirOut, "e.yaml")), /no nodes/);
});

test("CLI: init --templates, new --template, templates, template show/export", () => {
  const dir = tmpdir();
  const env = { XDG_CONFIG_HOME: tmpdir() };
  let r = cliEnv(dir, env, SCRIPT, "init", "--templates");
  assert.equal(r.code, 0, r.err);
  const example = path.join(dir, ".decisions", "templates", "example.yaml");
  assert.match(fs.readFileSync(example, "utf8"), /^# Example custom decision-tree template/);
  assert.equal(dt.loadTemplate(example).name, "example");
  fs.writeFileSync(path.join(dir, "my.yaml"), tplText("my", "Mine", "description: |\n  From the template\n").replace(
    "    kind: why\n", "    kind: why\n    body: |\n      - dash first\n    children:\n      - title: Opt\n        type: option\n        pros: [p]\n"));
  r = cliEnv(dir, env, SCRIPT, "new", "X", "--template", "./my.yaml");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created tree x with root goal g1 and 2 node\(s\) from template my/);
  r = cliEnv(dir, env, SCRIPT, "show", "x", "--body");
  assert.match(r.out, /\[q2\] question WHY: First question/);
  assert.match(r.out, /\[o3\] option Opt/);
  assert.match(r.out, /│ From the template/);
  const tree = JSON.parse(cliEnv(dir, env, SCRIPT, "show", "x", "--json").out);
  assert.equal(tree.template, "my");
  assert.equal(tree.description, "From the template");
  r = cliEnv(dir, env, SCRIPT, "new", "Y", "--template", "example", "-d", "-own description");
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(cliEnv(dir, env, SCRIPT, "show", "y", "--json").out).description, "-own description");
  r = cliEnv(dir, env, SCRIPT, "add", "y", "-p", "g1", "-t", "note", "--title", "n", "-b", "- dash body");
  assert.equal(r.code, 0, r.err);
  r = cliEnv(dir, env, SCRIPT, "templates");
  assert.match(r.out, /\* example\s+project\s+Example custom template/);
  assert.match(r.out, /searched:/);
  r = cliEnv(dir, env, SCRIPT, "template", "show", "example");
  assert.match(r.out, /# Example custom template {2}\[example\]/);
  assert.match(r.out, /- option Simplest thing that could work/);
  assert.equal(JSON.parse(cliEnv(dir, env, SCRIPT, "template", "show", "example", "--json").out).name, "example");
  r = cliEnv(dir, env, SCRIPT, "template", "export", "x", "-o", "exported.yaml");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /exported 2 node\(s\) as template exported/);
  r = cliEnv(dir, env, SCRIPT, "new", "Z", "--template", "exported.yaml");
  assert.equal(r.code, 0, r.err);
  const z = JSON.parse(cliEnv(dir, env, SCRIPT, "show", "z", "--json").out);
  assert.equal(z.nodes.q2.body, "- dash first");
  assert.deepEqual(z.nodes.o3.pros, ["p"]);

  const before = fs.readdirSync(path.join(dir, ".decisions")).sort();
  fs.writeFileSync(path.join(dir, "bad.yaml"), "template: 1\nname: bad\ntitle: B\nnodes:\n  - title: ok\n  - type: goal\n    title: g\n");
  r = cliEnv(dir, env, SCRIPT, "new", "Bad", "--template", "bad.yaml");
  assert.equal(r.code, 1);
  assert.match(r.err, /error: template "bad" \(.*bad\.yaml\): nodes\[1\]: type "goal" is reserved/);
  r = cliEnv(dir, env, SCRIPT, "new", "Bad", "--template", "nope");
  assert.equal(r.code, 1);
  assert.match(r.err, /template "nope" not found/);
  assert.deepEqual(fs.readdirSync(path.join(dir, ".decisions")).sort(), before);
  const fresh = tmpdir();
  assert.equal(cliEnv(fresh, env, SCRIPT, "new", "Bad", "--template", path.join(dir, "bad.yaml")).code, 1);
  assert.ok(!fs.existsSync(path.join(fresh, ".decisions")), "failed template leaves no .decisions dir");

  assert.equal(cliEnv(dir, env, SCRIPT, "new", "W", "--template", "a", "--mode", "b").code, 2);
  assert.equal(cliEnv(dir, env, SCRIPT, "template", "frob", "x").code, 2);
  assert.equal(cliEnv(dir, env, SCRIPT, "template", "show").code, 2);
  assert.match(cliEnv(dir, env, SCRIPT, "template", "export", "x").err, /-o\/--out is required/);
});

test("CLI: create-mode -> modes -> new --mode -> remove-mode", () => {
  const dir = tmpdir();
  const xdg = tmpdir();
  const env = { XDG_CONFIG_HOME: xdg };
  const src = path.join(dir, "custom-planning.yaml");
  fs.writeFileSync(src, "# my comment survives\ntemplate: 1\nname: whatever\ntitle: Custom planning\nnodes:\n  - title: Why?\n    kind: why\n");
  let r = cliEnv(dir, env, SCRIPT, "create-mode", "custom-planning", "--yaml", "./custom-planning.yaml");
  assert.equal(r.code, 0, r.err);
  const saved = path.join(dir, ".decisions", "templates", "custom-planning.yaml");
  assert.match(r.out, new RegExp(`saved project mode custom-planning to ${saved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(r.out, /use it: dtree new "<title>" --mode custom-planning/);
  const text = fs.readFileSync(saved, "utf8");
  assert.match(text, /^# my comment survives\n/);
  assert.match(text, /^name: custom-planning$/m);
  r = cliEnv(dir, env, SCRIPT, "modes");
  assert.match(r.out, /\* custom-planning\s+project\s+Custom planning/);
  assert.deepEqual(JSON.parse(cliEnv(dir, env, SCRIPT, "modes", "--json").out), JSON.parse(cliEnv(dir, env, SCRIPT, "templates", "--json").out));
  r = cliEnv(dir, env, SCRIPT, "new", "Plan it", "--mode", "custom-planning");
  assert.equal(r.code, 0, r.err);
  const tree = JSON.parse(cliEnv(dir, env, SCRIPT, "show", "plan-it", "--json").out);
  assert.equal(tree.template, "custom-planning");
  assert.equal(tree.nodes.q2.title, "Why?");

  r = cliEnv(dir, env, SCRIPT, "create-mode", "custom-planning", "--yaml", src);
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists .*pass --force/);
  fs.writeFileSync(src, "template: 1\ntitle: Replaced\nnodes:\n  - title: New\n");
  r = cliEnv(dir, env, SCRIPT, "create-mode", "custom-planning", "--yaml", src, "--force");
  assert.equal(r.code, 0, r.err);
  assert.equal(dt.loadTemplate(saved).title, "Replaced");
  assert.equal(dt.loadTemplate(saved).name, "custom-planning");

  const invalid = path.join(dir, "invalid.yaml");
  const userSaved = path.join(xdg, "decision-tree", "templates", "custom-planning.yaml");
  for (const body of ["template: 1\nname: x\ntitle: T\nnodes: &a\n", "template: 1\nname: x\ntitle: T\nnodes:\n  - type: goal\n    title: g\n"]) {
    fs.writeFileSync(invalid, body);
    const snapshot = fs.readFileSync(saved, "utf8");
    r = cliEnv(dir, env, SCRIPT, "create-mode", "custom-planning", "--yaml", invalid, "--force");
    assert.equal(r.code, 1);
    assert.match(r.err, /invalid\.yaml:4: anchors|nodes\[0\]: type "goal" is reserved/);
    assert.equal(fs.readFileSync(saved, "utf8"), snapshot, "invalid YAML must not overwrite");
    r = cliEnv(dir, env, SCRIPT, "create-mode", "brand-new", "--yaml", invalid, "--user");
    assert.equal(r.code, 1);
    assert.ok(!fs.existsSync(path.join(xdg, "decision-tree")), "invalid YAML must not create the user dir");
    assert.ok(!fs.existsSync(path.join(dir, ".decisions", "templates", "brand-new.yaml")));
  }
  const empty = tmpdir();
  assert.equal(cliEnv(empty, env, SCRIPT, "create-mode", "x", "--yaml", invalid).code, 1);
  assert.ok(!fs.existsSync(path.join(empty, ".decisions")));
  assert.equal(cliEnv(dir, env, SCRIPT, "create-mode", "Bad Name", "--yaml", src).code, 1);
  assert.equal(cliEnv(dir, env, SCRIPT, "create-mode", "x", "--yaml", "missing.yaml").code, 1);
  assert.equal(cliEnv(dir, env, SCRIPT, "create-mode", "x").code, 2);

  r = cliEnv(dir, env, SCRIPT, "create-mode", "custom-planning", "--yaml", src, "--user");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /saved user mode custom-planning to .*decision-tree[\\/]templates[\\/]custom-planning\.yaml/);
  assert.ok(fs.existsSync(userSaved));
  let rows = JSON.parse(cliEnv(dir, env, SCRIPT, "modes", "--json").out).filter((x) => x.name === "custom-planning");
  assert.deepEqual(rows.map((x) => [x.source, x.active]), [["project", true], ["user", false]]);

  r = cliEnv(dir, env, SCRIPT, "remove-mode", "custom-planning");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /removed project mode custom-planning/);
  assert.match(r.out, /now resolves to the user template/);
  assert.ok(!fs.existsSync(saved));
  r = cliEnv(dir, env, SCRIPT, "remove-mode", "custom-planning");
  assert.equal(r.code, 1);
  assert.match(r.err, /it is a user template .*\(pass --user\)/);
  r = cliEnv(dir, env, SCRIPT, "remove-mode", "custom-planning", "--user");
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(userSaved));
  r = cliEnv(dir, env, SCRIPT, "remove-mode", "custom-planning", "--user");
  assert.equal(r.code, 1);
  assert.match(r.err, /mode "custom-planning" not found/);
  rows = JSON.parse(cliEnv(dir, env, SCRIPT, "modes", "--json").out);
  assert.ok(!rows.some((x) => x.name === "custom-planning"));
});

test("remove-mode refuses built-in templates", () => {
  const store = new dt.Store(tmpdir());
  withTemplateEnv({ XDG_CONFIG_HOME: tmpdir() }, () => {
    const builtin = dt.builtinTemplatesDir();
    const real = fs.existsSync(builtin) ? fs.readdirSync(builtin).find((f) => /\.ya?ml$/.test(f)) : null;
    if (real) {
      const name = real.replace(/\.ya?ml$/, "");
      assert.throws(() => dt.removeMode(store, name), /is a built-in template and cannot be removed/);
      assert.throws(() => dt.removeMode(store, name, { user: true }), /is a built-in template/);
      assert.ok(fs.existsSync(path.join(builtin, real)));
    }
    assert.throws(() => dt.removeMode(store, "nope"), /mode "nope" not found/);
    assert.throws(() => dt.removeMode(store, "../etc"), /invalid template name/);
  });
  const skill = path.join(tmpdir(), "skills", "decision-tree");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(skill, "templates"));
  fs.copyFileSync(SCRIPT, path.join(skill, "scripts", "dtree.cjs"));
  fs.copyFileSync(path.join(path.dirname(SCRIPT), "viewer.html"), path.join(skill, "scripts", "viewer.html"));
  fs.cpSync(path.join(path.dirname(SCRIPT), "lib"), path.join(skill, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(skill, "templates", "shipped.yaml"), tplText("shipped"));
  const r = cliEnv(tmpdir(), { XDG_CONFIG_HOME: tmpdir() }, path.join(skill, "scripts", "dtree.cjs"), "remove-mode", "shipped");
  assert.equal(r.code, 1);
  assert.match(r.err, /"shipped" is a built-in template and cannot be removed/);
  assert.ok(fs.existsSync(path.join(skill, "templates", "shipped.yaml")));
});

test("HTTP API lists templates and creates trees from them", async (t) => {
  const store = new dt.Store(tmpdir());
  store.init(false, { templates: true });
  fs.writeFileSync(path.join(store.dir, "templates", "api-tpl.yaml"), tplText("api-tpl", "API template", "description: Seeded desc\ntree_status: active\n"));
  const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DTREE_TEMPLATES_PATH: process.env.DTREE_TEMPLATES_PATH };
  process.env.XDG_CONFIG_HOME = tmpdir();
  delete process.env.DTREE_TEMPLATES_PATH;
  const server = dt.createServer(new dt.App([store.root]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    for (const [k, v] of Object.entries(restore)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  let r = await call("GET", "/api/projects/0/templates");
  assert.equal(r.status, 200);
  const mine = r.data.filter((x) => x.source === "project");
  assert.deepEqual(mine.map((x) => [x.name, x.title, x.active, x.nodes]), [["api-tpl", "API template", true, 1], ["example", "Example custom template", true, 5]]);
  r = await call("POST", "/api/projects/0/trees", { title: "From API", template: "api-tpl" });
  assert.equal(r.status, 200);
  assert.equal(r.data.template, "api-tpl");
  assert.equal(r.data.status, "active");
  assert.equal(r.data.description, "Seeded desc");
  assert.equal(r.data.nodes.q2.title, "First question");
  assert.equal(r.data.nodes.q2.created_by.type, "human");
  r = await call("POST", "/api/projects/0/trees", { title: "Own desc", template: "example", description: "mine" });
  assert.equal(r.data.description, "mine");
  assert.equal((await call("POST", "/api/projects/0/trees", { title: "Nope", template: "nope" })).status, 400);
  r = await call("POST", "/api/projects/0/trees", { title: "Path", template: "../../etc/x.yaml" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /must be a name, not a path/);
  assert.deepEqual(store.slugs(), ["from-api", "own-desc"]);
  assert.equal((await call("GET", "/api/projects/7/templates")).status, 400);
  const port = server.address().port;
  const raw = (headers, method, p, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(body);
    });
  assert.equal(await raw({ Origin: "http://evil.example" }, "GET", "/api/projects/0/templates"), 403);
  assert.equal(await raw({ Host: `evil.example:${port}` }, "GET", "/api/projects/0/templates"), 403);
  const evil = JSON.stringify({ title: "Evil", template: "example" });
  assert.equal(await raw({ "Content-Type": "text/plain", Origin: "http://evil.example" }, "POST", "/api/projects/0/trees", evil), 403);
  assert.deepEqual(store.slugs(), ["from-api", "own-desc"]);
});

test("HTTP API saves a tree as a project template", async (t) => {
  const store = new dt.Store(tmpdir());
  store.init();
  const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DTREE_TEMPLATES_PATH: process.env.DTREE_TEMPLATES_PATH };
  process.env.XDG_CONFIG_HOME = tmpdir();
  delete process.env.DTREE_TEMPLATES_PATH;
  const server = dt.createServer(new dt.App([store.root]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    for (const [k, v] of Object.entries(restore)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const port = server.address().port;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const src = store.createTree("src", "Source tree", "Plan it", AGENT);
  store.edit("src", (tree) => {
    const q = dt.addNode(tree, { parent: tree.root_id, type: "question", title: "Which store?", kind: "how", body: "Pick one", author: AGENT });
    const o = dt.addNode(tree, { parent: q.id, type: "option", title: "Postgres", pros: ["SQL"], cons: ["Ops"], author: AGENT });
    dt.addNode(tree, { parent: q.id, type: "option", title: "SQLite", author: AGENT });
    dt.chooseOption(tree, o.id, "because", AGENT);
    dt.addComment(tree, q.id, "hmm", HUMAN);
  });
  assert.equal(src.id, "src");
  let r = await call("POST", "/api/projects/0/templates", { tree: "src", name: "my-plan" });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, "my-plan");
  assert.equal(r.data.source, "project");
  assert.equal(r.data.nodes, 3);
  assert.equal(r.data.path, path.join(store.dir, "templates", "my-plan.yaml"));
  const tpl = dt.resolveTemplate(store, "my-plan");
  assert.equal(tpl.title, "Source tree");
  assert.deepEqual(tpl.nodes.map((n) => [n.title, n.kind, n.status, n.children.map((c) => [c.title, c.type, c.status, c.pros])]),
    [["Which store?", "how", "open", [["Postgres", "option", "open", ["SQL"]], ["SQLite", "option", "open", []]]]]);
  assert.doesNotMatch(fs.readFileSync(r.data.path, "utf8"), /hmm|because|q2|chosen/);
  r = await call("POST", "/api/projects/0/trees", { title: "Reuse", template: "my-plan" });
  assert.equal(r.status, 200);
  assert.equal(Object.keys(r.data.nodes).length, 4);
  r = await call("POST", "/api/projects/0/templates", { tree: "src", name: "my-plan" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already exists/);
  assert.equal((await call("POST", "/api/projects/0/templates", { tree: "src", name: "my-plan", force: true })).status, 200);
  assert.match((await call("POST", "/api/projects/0/templates", { tree: "src", name: "../x" })).data.error, /invalid template name/);
  assert.match((await call("POST", "/api/projects/0/templates", { tree: "nope", name: "x" })).data.error, /not found/);
  assert.match((await call("POST", "/api/projects/0/templates", { tree: "reuse" })).data.error, /missing "name"/);
  store.createTree("empty", "Empty", "", AGENT);
  assert.match((await call("POST", "/api/projects/0/templates", { tree: "empty", name: "empty" })).data.error, /no nodes/);
  assert.equal((await call("POST", "/api/projects/0/templates", { tree: "src", name: "evil" }, { Origin: "http://evil.example" })).status, 403);
  assert.deepEqual(fs.readdirSync(path.join(store.dir, "templates")), ["my-plan.yaml"]);
});
