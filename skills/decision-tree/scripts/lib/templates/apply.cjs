"use strict";

/** Seeding a tree from validated, resolved template nodes (sub-trees already expanded, see subtrees.cjs). */

const { addNode, lockNode, log } = require("../core/tree.cjs");
const { countTemplateNodes } = require("./schema.cjs");
const { expandSubtrees } = require("./subtrees.cjs");

/** Adds template `nodes` under `parentId`, preserving order and nesting; locks apply once all are added. */
function applyNodes(tree, nodes, parentId, author) {
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
        mode: n.mode,
        config: n.config,
      });
      if (n.lock) locks.push([node.id, n.lock]);
      walk(n.children, node.id);
    }
  };
  walk(nodes, parentId);
  for (const [nid, lock] of locks) lockNode(tree, nid, lock, author);
}

/** Adds a tree node for resolved sub-tree `sub` ({mode, config, nodes}) with node `fields`, seeding its nodes below it. */
function addSubtree(tree, sub, fields, author) {
  const node = addNode(tree, { ...fields, type: "tree", mode: sub.mode, config: sub.config, author });
  applyNodes(tree, sub.nodes, node.id, author);
  return node;
}

/** Adds a template's nodes under the root goal (expanding sub-trees from `store`'s modes) and applies its tree status. */
function applyTemplate(tree, tpl, author, store) {
  const { nodes } = store ? expandSubtrees(store, tpl) : tpl;
  applyNodes(tree, nodes, tree.root_id, author);
  if (tpl.tree_status) tree.status = tpl.tree_status;
  log(tree, author, "template", tree.root_id, `${tpl.name} (${tpl.source || "path"}): ${countTemplateNodes(nodes)} node(s)`);
}

module.exports = { applyNodes, addSubtree, applyTemplate };
