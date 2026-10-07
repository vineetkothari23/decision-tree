"use strict";

/**
 * JSON API routes: a table of {method, path, handler}; `edit` handlers run inside a locked tree write.
 * Tree routes exist twice, under `trees/` and under `drafts/` (mode drafts), with the same handlers.
 */

const { AUTHOR_TYPES } = require("../constants.cjs");
const { DTError, choice, hasOwn, slugify, validateSlug } = require("../util.cjs");
const { meta } = require("../config/meta.cjs");
const { configAt, configUnder } = require("../config/scope.cjs");
const { NODE_KEYS, addNode, updateNode, lockNode, moveNode, deleteNode, addLink, removeLink, updateTreeMeta } = require("../core/tree.cjs");
const { chooseOption } = require("../core/choose.cjs");
const { addComment, resolveComment } = require("../core/comments.cjs");
const { DraftStore } = require("../store/drafts.cjs");
const { listTemplates } = require("../templates/lookup.cjs");
const { resolveTemplate } = require("../templates/resolve.cjs");
const { resolveSubtree, resolveMode } = require("../templates/subtrees.cjs");
const { addSubtree } = require("../templates/apply.cjs");
const { validateTemplateName } = require("../templates/schema.cjs");
const { saveTreeAsMode } = require("../templates/modes.cjs");
const { openDraft, setDraftConfig, saveDraft } = require("../templates/drafts.cjs");

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

/** The node edits in a request body: node keys, the field ids configured in `cfg`, and `fields`. */
function nodeChanges(cfg, body) {
  const keys = [...NODE_KEYS, ...Object.keys(cfg.fields), "fields"];
  return Object.fromEntries(keys.filter((k) => hasOwn(body, k)).map((k) => [k, body[k]]));
}

const PROJECT = "projects/:project";
const DRAFT = `${PROJECT}/drafts/:tree`;

const treeRoutes = (coll) => {
  const TREE = `${PROJECT}/${coll}/:tree`;
  const NODE = `${TREE}/nodes/:node`;
  return [
    { method: "GET", path: TREE, handle: ({ trees, params }) => trees.load(params.tree) },
    { method: "PATCH", path: TREE, edit: (tree, { body, author }) => updateTreeMeta(tree, body, author) },
    {
      method: "POST",
      path: `${TREE}/nodes`,
      edit: (tree, { store, body, author }) => {
        const node = {
          ...nodeChanges(configUnder(tree, body.parent), body),
          parent: need(body, "parent"),
          type: body.type || "question",
          title: body.title || "",
          kind: body.kind || null,
          status: body.status || null,
          lock: body.lock || null,
          author,
        };
        if (node.type !== "tree") addNode(tree, node);
        else addSubtree(tree, resolveSubtree(store, String(need(body, "mode")), { seed: coll === "trees" }), node, author);
        return tree;
      },
    },
    {
      method: "PATCH",
      path: NODE,
      edit: (tree, { body, author, params }) => {
        const relock = hasOwn(body, "lock") && body.lock;
        if (hasOwn(body, "lock") && !relock) lockNode(tree, params.node, null, author);
        if (body.parent) moveNode(tree, params.node, body.parent, author);
        updateNode(tree, params.node, nodeChanges(configAt(tree, params.node), body), author);
        if (relock) lockNode(tree, params.node, body.lock, author);
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
        addLink(tree, params.node, need(body, "target"), body.type || null, author);
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
  ].map((r) => ({ ...r, coll }));
};

const ROUTES = [
  { method: "GET", path: "meta", handle: () => meta() },
  {
    method: "GET",
    path: "projects",
    handle: ({ app }) => app.stores().map((s, i) => ({ id: String(i), name: s.name, path: s.root, trees: s.summaries(), drafts: new DraftStore(s.root).summaries() })),
  },
  { method: "GET", path: `${PROJECT}/templates`, handle: ({ store }) => listTemplates(store) },
  {
    method: "GET",
    path: `${PROJECT}/templates/:name`,
    handle: ({ store, params }) => resolveTemplate(store, validateTemplateName(params.name), { allowPath: false }),
  },
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
      const template = body.template ? resolveMode(store, String(body.template), { allowPath: false }) : null;
      const description = body.description || (template ? template.description : "");
      return store.createTree(slug, title, description, requestAuthor(body), template);
    },
  },
  { method: "GET", path: `${PROJECT}/drafts`, handle: ({ drafts }) => drafts.summaries() },
  {
    method: "POST",
    path: `${PROJECT}/drafts`,
    handle: ({ store, drafts, body }) => openDraft(store, drafts, {
      name: String(need(body, "name")),
      from: body.from ? String(body.from) : null,
      parent: body.extends ? String(body.extends) : null,
      reset: body.reset === true,
    }, requestAuthor(body)),
  },
  {
    method: "PATCH",
    path: `${DRAFT}/config`,
    coll: "drafts",
    edit: (tree, { store, body, author }) => setDraftConfig(store, tree, { config: body.config, extends: body.extends }, author),
  },
  {
    method: "POST",
    path: `${DRAFT}/save`,
    handle: ({ store, drafts, params, body }) => saveDraft(store, drafts, params.tree, { force: body.force === true }),
  },
  {
    method: "DELETE",
    path: DRAFT,
    handle: ({ drafts, params }) => {
      drafts.load(params.tree);
      drafts.remove(params.tree);
      return { removed: params.tree };
    },
  },
  ...treeRoutes("trees"),
  ...treeRoutes("drafts"),
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
    const drafts = store ? new DraftStore(store.root) : null;
    const trees = route.coll === "drafts" ? drafts : store;
    if (route.handle) return route.handle({ app, store, drafts, trees, params, body });
    const author = requestAuthor(body);
    return trees.edit(params.tree, (tree) => route.edit(tree, { store, body, author, params }));
  }
  throw new DTError("unknown endpoint");
}

module.exports = { api, ROUTES };
