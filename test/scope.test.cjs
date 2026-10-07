"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const dt = require(path.join(__dirname, "..", "skills", "decision-tree", "scripts", "dtree.cjs"));

const A = { tag: "a" };
const B = { tag: "b" };
const ROOT = { tag: "root" };

const node = (id, parent, extra = {}) => ({ id, parent, type: "question", ...extra });

/** g1 > q2 > s3(A) > q4 > s5(B) > q6, plus s7 (tree type, no config) > q8 under q2. */
function nested(config = ROOT) {
  const nodes = [
    node("g1", null, { type: "goal" }), node("q2", "g1"), node("s3", "q2", { type: "tree", config: A }), node("q4", "s3"),
    node("s5", "q4", { type: "tree", config: B }), node("q6", "s5"), node("s7", "q2", { type: "tree" }), node("q8", "s7"),
  ];
  return { id: "t", root_id: "g1", ...(config ? { config } : {}), nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) };
}

test("configAt: nearest enclosing tree node's config; the tree node itself follows its parent", () => {
  const t = nested();
  const at = (id) => dt.configAt(t, id).tag;
  assert.deepEqual(["g1", "q2", "s3", "q4", "s5", "q6", "s7", "q8"].map(at), ["root", "root", "root", "a", "a", "b", "root", "root"]);
  assert.deepEqual(["g1", "q2", "s3", "q4", "s5", "q6", "q8"].map((id) => dt.scopeRoot(t, id)), ["g1", "g1", "g1", "s3", "s3", "s5", "g1"]);
});

test("configUnder: children of a tree node use its config; otherwise the parent's scope", () => {
  const t = nested();
  assert.equal(dt.configUnder(t, "s3").tag, "a");
  assert.equal(dt.configUnder(t, "q4").tag, "a");
  assert.equal(dt.configUnder(t, "s5").tag, "b");
  assert.equal(dt.configUnder(t, "s7").tag, "root");
  assert.equal(dt.configUnder(t, null).tag, "root");
});

test("configAt: legacy trees, unknown ids and parent cycles fall back to the file scope", () => {
  const t = nested(null);
  assert.equal(dt.configAt(t, "q2"), dt.LEGACY_CONFIG);
  assert.equal(dt.configAt(t, "q6").tag, "b");
  assert.equal(dt.configAt(t, "nope"), dt.LEGACY_CONFIG);
  assert.equal(dt.configUnder(t, "nope"), dt.LEGACY_CONFIG);
  t.nodes.q2.parent = "q4";
  t.nodes.s3.config = undefined;
  assert.equal(dt.configAt(t, "q4"), dt.LEGACY_CONFIG);
  t.nodes.q4.parent = "q4";
  assert.equal(dt.configAt(t, "q4"), dt.LEGACY_CONFIG);
});
