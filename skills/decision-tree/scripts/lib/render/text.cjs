"use strict";

/** Plain-text outlines of trees and templates for the CLI. */

const { threads } = require("../core/comments.cjs");
const { children } = require("../core/tree.cjs");
const { treeConfig, LEGACY_CONFIG } = require("../config/legacy.cjs");
const { initialStatus } = require("../config/roles.cjs");

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
    if (n.labels && n.labels.length) marks.push(n.labels.map((l) => `#${l}`).join(" "));
    if (n.lock) marks.push(`locked: ${n.lock}`);
    const tail = marks.length ? `  <${marks.join("; ")}>` : "";
    return `[${n.id}] ${n.type}${n.mode ? `:${n.mode}` : ""} ${kind}${n.title}  (${n.status})${tail}`;
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

/** A config's vocabularies, one line per section. */
function renderConfig(cfg) {
  const entries = (o, extra) => Object.entries(o).map(([id, e]) => `${id}${extra(e)}`).join(", ") || "-";
  return [
    `statuses: ${entries(cfg.statuses, (e) => ` (${e.role})`)}`,
    `fields: ${entries(cfg.fields, (e) => ` (${e.type})`)}`,
    `link types: ${Object.keys(cfg.link_types).join(", ") || "-"}`,
    `kinds: ${cfg.kinds.join(", ") || "-"}`,
    `labels: ${cfg.labels.join(", ") || "-"}`,
    `comments: ${cfg.comments.threads ? "threaded" : "flat"}`,
    `review requires kinds: ${cfg.review.required_kinds.join(", ") || "-"}`,
  ].join("\n");
}

/** `tree`'s config as text, naming the mode it came from. */
const renderTreeConfig = (tree) =>
  `# ${tree.id}: ${tree.config ? `mode ${tree.template || "?"}` : "legacy (no mode config)"}\n${renderConfig(treeConfig(tree))}`;

function renderTemplate(tpl) {
  const cfg = tpl.resolved_config || LEGACY_CONFIG;
  const lines = [`# ${tpl.title}  [${tpl.name}] (${tpl.source || "path"}: ${tpl.path || "-"})`];
  if (tpl.tree_status) lines.push(`tree status: ${tpl.tree_status}`);
  if (tpl.resolved_config) lines.push(`extends: ${(tpl.chain || []).slice(1).join(" -> ") || "-"}`, ...renderConfig(cfg).split("\n"));
  for (const l of tpl.description.replace(/\n+$/, "").split("\n")) if (tpl.description) lines.push(`  ${l}`);
  const walk = (list, depth) => {
    for (const n of list) {
      const pad = "  ".repeat(depth);
      const kind = n.kind ? `${n.kind.toUpperCase()}: ` : "";
      const extra = [n.status !== initialStatus(cfg) ? n.status : "", ...(n.labels || []).map((l) => `#${l}`), n.lock ? `locked: ${n.lock}` : "", n.assignee ? `@${n.assignee}` : ""].filter(Boolean).join(", ");
      lines.push(`${pad}- ${n.type}${n.mode ? `:${n.mode}` : ""} ${kind}${n.title}${extra ? `  (${extra})` : ""}`);
      for (const l of n.body.replace(/\n+$/, "").split("\n")) if (n.body) lines.push(`${pad}    │ ${l}`);
      if (n.pros.length) lines.push(`${pad}    pros: ${n.pros.join("; ")}`);
      if (n.cons.length) lines.push(`${pad}    cons: ${n.cons.join("; ")}`);
      walk(n.children || [], depth + 1);
    }
  };
  walk(tpl.nodes, 0);
  return lines.join("\n");
}

module.exports = { renderText, renderTemplate, renderConfig, renderTreeConfig };
