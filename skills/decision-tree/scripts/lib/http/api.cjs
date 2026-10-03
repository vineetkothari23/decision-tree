"use strict";

/** JSON API routes: a table of {method, path, handler}; `edit` handlers run inside a locked tree write. */

const { AUTHOR_TYPES, EDITABLE_NODE_FIELDS, meta } = require("../constants.cjs");
const { DTError, choice, slugify, validateSlug } = require("../util.cjs");
const { addNode, updateNode, moveNode, deleteNode, chooseOption, addLink, removeLink, updateTreeMeta } = require("../core/tree.cjs");
const { addComment, resolveComment } = require("../core/comments.cjs");
const { resolveTemplate, listTemplates } = require("../templates/lookup.cjs");
const { validateTemplateName } = require("../templates/schema.cjs");
const { saveTreeAsMode } = require("../templates/modes.cjs");

function requestAuthor(body) {
  const name = String(body.author || "human").trim().slice(0, 80) || "human";
  return { name, type: choice(body.author_type || "human", AUTHOR_TYPES, "author type") };
}

function need(body, key) {
  if (body[key] === undefined || body[key] === null || body[key] === "") {
    throw new DTError(`bad request: missing ${JSON.stringify(key)}`);
  }
  return body[key];
}

const PROJECT = "projects/:project";
const TREE = `${PROJECT}/trees/:tree`;
const NODE = `${TREE}/nodes/:node`;

const ROUTES = [
  { method: "GET", path: "meta", handle: () => meta() },
  {
    method: "GET",
    path: "projects",
    handle: ({ app }) => app.stores().map((s, i) => ({ id: String(i), name: s.name, path: s.root, trees: s.summaries() })),
  },
  { method: "GET", path: `${PROJECT}/templates`, handle: ({ store }) => listTemplates(store) },
  {
    method: "POST",
    path: `${PROJECT}/templates`,
    handle: ({ store, body }) => {
      const name = validateTemplateName(String(need(body, "name")));
      return saveTreeAsMode(store, store.load(String(need(body, "tree"))), name, { force: body.force === true });
    },
  },
  {
    method: "POST",
    path: `${PROJECT}/trees`,
    handle: ({ store, body }) => {
      const title = String(body.title || "").trim();
      if (!title) throw new DTError("title is required");
      const slug = validateSlug(body.id || slugify(title));
      const template = body.template ? resolveTemplate(store, String(body.template), { allowPath: false }) : null;
      const description = body.description || (template ? template.description : "");
      return store.createTree(slug, title, description, requestAuthor(body), template);
    },
  },
  { method: "GET", path: TREE, handle: ({ store, params }) => store.load(params.tree) },
  { method: "PATCH", path: TREE, edit: (tree, { body, author }) => updateTreeMeta(tree, body, author) },
  {
    method: "POST",
    path: `${TREE}/nodes`,
    edit: (tree, { body, author }) => {
      addNode(tree, {
        parent: need(body, "parent"),
        type: body.type || "question",
        title: body.title || "",
        body: body.body || "",
        kind: body.kind || null,
        status: body.status || "open",
        author,
        pros: body.pros,
        cons: body.cons,
        assignee: body.assignee || "",
      });
      return tree;
    },
  },
  {
    method: "PATCH",
    path: NODE,
    edit: (tree, { body, author, params }) => {
      if (body.parent) moveNode(tree, params.node, body.parent, author);
      updateNode(tree, params.node, Object.fromEntries(EDITABLE_NODE_FIELDS.map((k) => [k, body[k]])), author);
      return tree;
    },
  },
  {
    method: "DELETE",
    path: NODE,
    edit: (tree, { author, params }) => {
      deleteNode(tree, params.node, author);
      return tree;
    },
  },
  {
    method: "POST",
    path: `${NODE}/choose`,
    edit: (tree, { body, author, params }) => {
      chooseOption(tree, params.node, body.rationale || "", author, body.reject_siblings ?? true);
      return tree;
    },
  },
  {
    method: "POST",
    path: `${NODE}/comments`,
    edit: (tree, { body, author, params }) => {
      addComment(tree, params.node, body.text || "", author, body.reply_to || null);
      return tree;
    },
  },
  {
    method: "PATCH",
    path: `${NODE}/comments/:comment`,
    edit: (tree, { body, author, params }) => {
      resolveComment(tree, params.node, params.comment, Boolean(body.resolved ?? true), author);
      return tree;
    },
  },
  {
    method: "POST",
    path: `${NODE}/links`,
    edit: (tree, { body, author, params }) => {
      addLink(tree, params.node, need(body, "target"), body.type || "relates-to", author);
      return tree;
    },
  },
  {
    method: "DELETE",
    path: `${NODE}/links`,
    edit: (tree, { body, author, params }) => {
      removeLink(tree, params.node, need(body, "target"), body.type || null, author);
      return tree;
    },
  },
].map((r) => ({ ...r, segments: r.path.split("/") }));

/** Path params for `segments` (":name" captures one part), or null when `parts` does not match. */
function matchPath(segments, parts) {
  if (segments.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith(":")) params[segments[i].slice(1)] = parts[i];
    else if (segments[i] !== parts[i]) return null;
  }
  return params;
}

function api(app, method, parts, body) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = matchPath(route.segments, parts);
    if (!params) continue;
    const store = params.project === undefined ? null : app.store(params.project);
    if (route.handle) return route.handle({ app, store, params, body });
    const author = requestAuthor(body);
    return store.edit(params.tree, (tree) => route.edit(tree, { body, author, params }));
  }
  throw new DTError("unknown endpoint");
}

module.exports = { api, ROUTES };
