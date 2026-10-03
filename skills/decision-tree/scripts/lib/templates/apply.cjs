"use strict";

/** Seeding a new tree from a validated template. */

const { addNode, log } = require("../core/tree.cjs");
const { countTemplateNodes } = require("./schema.cjs");

/** Adds a validated template's nodes under the root goal, preserving order and nesting. */
function applyTemplate(tree, tpl, author) {
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
      });
      walk(n.children, node.id);
    }
  };
  walk(tpl.nodes, tree.root_id);
  if (tpl.tree_status) tree.status = tpl.tree_status;
  log(tree, author, "template", tree.root_id, `${tpl.name} (${tpl.source || "path"}): ${countTemplateNodes(tpl.nodes)} node(s)`);
}

module.exports = { applyTemplate };
