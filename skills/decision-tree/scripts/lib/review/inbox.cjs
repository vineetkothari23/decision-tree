"use strict";

/** What is waiting on agents or humans. */

const { threads } = require("../core/comments.cjs");

/** Items waiting on `audience` ('agent' or 'human'). */
function inbox(tree, audience) {
  const other = audience === "agent" ? "human" : "agent";
  const items = [];
  for (const node of Object.values(tree.nodes)) {
    for (const msgs of threads(node)) {
      const last = msgs[msgs.length - 1];
      if (!msgs[0].resolved && last.author_type === other) {
        items.push({ node: node.id, title: node.title, kind: "comment", thread: msgs[0].id, last });
      }
    }
    if (audience === "human" && node.status === "needs-input") {
      items.push({ node: node.id, title: node.title, kind: "needs-input" });
    }
  }
  return items;
}

module.exports = { inbox };
