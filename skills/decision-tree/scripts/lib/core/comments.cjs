"use strict";

/** Comment threads on nodes: add, resolve, and group replies under their root comment. */

const { DTError, now } = require("../util.cjs");
const { getNode, log } = require("./tree.cjs");
const { configAt } = require("../config/scope.cjs");

function addComment(tree, nid, text, author, replyTo = null) {
  const node = getNode(tree, nid);
  if (!text || !String(text).trim()) throw new DTError("comment text is required");
  if (replyTo && !configAt(tree, nid).comments.threads) {
    throw new DTError("this tree's mode has flat comments (comments.threads: false); add a new comment instead of a reply");
  }
  if (replyTo && !node.comments.some((c) => c.id === replyTo)) {
    throw new DTError(`comment ${JSON.stringify(replyTo)} not found on ${nid}`);
  }
  const comment = {
    id: `c${tree.next_id}`,
    author: author.name,
    author_type: author.type,
    text: String(text).trim(),
    reply_to: replyTo || null,
    resolved: false,
    created_at: now(),
  };
  tree.next_id += 1;
  node.comments.push(comment);
  log(tree, author, "comment", nid, comment.text.slice(0, 120));
  return comment;
}

function resolveComment(tree, nid, cid, resolved, author) {
  const node = getNode(tree, nid);
  const found = node.comments.find((x) => x.id === cid);
  if (!found) throw new DTError(`comment ${JSON.stringify(cid)} not found on ${nid}`);
  const c = threadRoot(node, found);
  c.resolved = resolved;
  log(tree, author, resolved ? "resolve" : "reopen", nid, c.id);
  return c;
}

function threadRoot(node, comment) {
  const byId = new Map(node.comments.map((c) => [c.id, c]));
  const seen = new Set([comment.id]);
  let c = comment;
  while (c.reply_to && byId.has(c.reply_to) && !seen.has(c.reply_to)) {
    c = byId.get(c.reply_to);
    seen.add(c.id);
  }
  return c;
}

/** Comment threads on a node: [root, ...replies], with replies-to-replies grouped under their root. */
function threads(node) {
  const groups = new Map();
  for (const c of node.comments) {
    const root = threadRoot(node, c);
    if (!groups.has(root.id)) groups.set(root.id, [root]);
    if (c !== root) groups.get(root.id).push(c);
  }
  return [...groups.values()];
}

module.exports = { addComment, resolveComment, threadRoot, threads };
