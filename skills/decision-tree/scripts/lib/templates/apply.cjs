"use strict";

/** Seeding a new tree from a validated, resolved template. */

const { addNode, lockNode, log } = require("../core/tree.cjs");
const { countTemplateNodes } = require("./schema.cjs");

/** Adds a template's nodes under the root goal, preserving order and nesting; locks apply once all are added. */
function applyTemplate(tree, tpl, author) {
  const locks = [];
  const walk = (list, parent) => {
    for (const n of list) {
      const node = addNode(tree, {
        parent,
        type: n.type,
        title: n.title,
        body: n.body,
        kind: n.kind,
        status: n.status,
        author,
        pros: n.pros,
        cons: n.cons,
        assignee: n.assignee,
        rationale: n.rationale,
        labels: n.labels,
        fields: n.fields || {},
      });
      if (n.lock) locks.push([node.id, n.lock]);
      walk(n.children, node.id);
    }
  };
  walk(tpl.nodes, tree.root_id);
  for (const [nid, lock] of locks) lockNode(tree, nid, lock, author);
  if (tpl.tree_status) tree.status = tpl.tree_status;
  log(tree, author, "template", tree.root_id, `${tpl.name} (${tpl.source || "path"}): ${countTemplateNodes(tpl.nodes)} node(s)`);
}

module.exports = { applyTemplate };
