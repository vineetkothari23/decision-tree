"use strict";

/** Self-contained read-only HTML snapshots. */

const fs = require("node:fs");
const { meta } = require("../config/meta.cjs");
const { VIEWER_HTML } = require("../paths.cjs");
const { now } = require("../util.cjs");
const { summarize } = require("../review/summary.cjs");

function renderStaticHtml(payload) {
  const html = fs.readFileSync(VIEWER_HTML, "utf8");
  const data = JSON.stringify(payload).replace(/<\//g, "<\\/");
  return html.replace("<!--DTREE_STATIC-->", () => `<script>window.DTREE_STATIC = ${data};</script>`);
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

module.exports = { renderStaticHtml, snapshotPayload };
