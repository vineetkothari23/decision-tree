"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dt = require("../skills/decision-tree/scripts/lib/index.cjs");

const AGENT = { name: "a", type: "agent" };
const project = (modes = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtree-rules-"));
  const store = new dt.Store(root);
  store.init();
  fs.mkdirSync(path.join(store.dir, "templates"), { recursive: true });
  for (const [name, text] of Object.entries(modes)) fs.writeFileSync(path.join(store.dir, "templates", `${name}.yaml`), `template: 1\nname: ${name}\ntitle: ${name}\n${text}`);
  return store;
};
const tree = (store, name) => store.createTree("t", "T", "", AGENT, dt.resolveTemplate(store, name));

const TASKS = `extends: base
config:
  statuses:
    done:
      name: Done
      role: closed
  fields:
    estimate:
      name: Estimate
      type: text
  features:
    choose:
      type: pick
      chosen: done
  node_types:
    epic:
      name: Epic
      root: true
      rules:
        - when:
            status: done
          require: all
          of:
            children: "*"
          where:
            status: [done, rejected]
          level: block
          message: finish every task first
    task:
      name: Task
      default: true
      fields: [body, estimate]
      statuses: [active, done]
      rules:
        - require: at-most 1
          of:
            children: 1
          message: a task has at most {count} children
    pick:
      name: Pick
      fields: [body]
      statuses: [active, done, rejected]
`;

test("node types restrict fields and statuses; rules warn in review and block status changes", () => {
  const store = project({ tasks: TASKS });
  const t = tree(store, "tasks");
  assert.equal(t.nodes[t.root_id].type, "epic");
  const a = dt.addNode(t, { parent: t.root_id, title: "A", fields: { estimate: "1d" }, author: AGENT });
  assert.equal(a.type, "task");
  assert.throws(() => dt.updateNode(t, a.id, { status: "rejected" }, AGENT), /status "rejected" is not allowed on task/);
  const p = dt.addNode(t, { parent: t.root_id, type: "pick", title: "P", author: AGENT });
  assert.throws(() => dt.updateNode(t, p.id, { estimate: "2d" }, AGENT), /field "estimate" is not allowed on pick/);
  assert.throws(() => dt.updateNode(t, t.root_id, { status: "done" }, AGENT), /cannot set e1 to done: finish every task first/);
  dt.addNode(t, { parent: a.id, title: "x", author: AGENT });
  dt.addNode(t, { parent: a.id, title: "y", author: AGENT });
  assert.ok(dt.review(t).some(([id, msg]) => id === a.id && msg === "a task has at most 2 children"));
  for (const n of Object.values(t.nodes)) if (n.id !== t.root_id && n.type !== "pick") dt.updateNode(t, n.id, { status: "done" }, AGENT);
  dt.chooseOption(t, p.id, "", AGENT);
  assert.equal(p.status, "done");
  dt.updateNode(t, t.root_id, { status: "done" }, AGENT);
});

test("config rejects bad node-type references, rules and features", () => {
  const bad = (cfg) => () => dt.resolveTemplate(project({ m: `extends: base\nconfig:\n${cfg}` }), "m");
  assert.throws(bad("  node_types:\n    a:\n      name: A\n      fields: [nope]\n"), /"nope" is not in fields/);
  assert.throws(bad("  node_types:\n    a:\n      name: A\n      root: true\n    b:\n      name: B\n      root: true\n"), /only one node type can be root/);
  assert.throws(bad("  node_types:\n    a:\n      name: A\n      rules:\n        - require: most\n"), /require: must be any, all/);
  assert.throws(bad("  node_types:\n    a:\n      name: A\n      rules:\n        - where:\n            status: nope\n"), /unknown status "nope"/);
  assert.throws(bad("  features:\n    choose:\n      type: nope\n"), /unknown node type "nope"/);
  assert.throws(bad("  node_types:\n    a:\n      name: A\n      color: red\n"), /color/);
});

test("decision-tree.yaml matches the compat vocabulary; new defaults to it; extends: default still resolves", () => {
  const store = project({ old: "extends: default\nconfig:\n  labels: [x]\n" });
  const cfg = dt.resolveTemplate(store, "decision-tree").resolved_config;
  assert.deepEqual(cfg.node_types, dt.LEGACY_CONFIG.node_types);
  assert.deepEqual(cfg.features, dt.LEGACY_CONFIG.features);
  assert.deepEqual(dt.resolveTemplate(store, "old").chain, ["old", "decision-tree", "base"]);
  assert.equal(dt.resolveTemplate(store, "default").name, "decision-tree");
  const t = store.createTree("d", "D", "", AGENT, dt.resolveTemplate(store, "decision-tree"));
  assert.equal(t.nodes[t.root_id].type, "goal");
  assert.equal(dt.addNode(t, { parent: t.root_id, title: "Q", author: AGENT }).type, "question");
});
