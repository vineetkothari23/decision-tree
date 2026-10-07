"use strict";

/** Public API of the package (`require("@vineetkothari23/decision-tree")`). */

const constants = require("./constants.cjs");
const { DTError, slugify, validateSlug } = require("./util.cjs");
const { Store } = require("./store/store.cjs");
const { findProjectRoot, scanProjects } = require("./store/projects.cjs");
const tree = require("./core/tree.cjs");
const comments = require("./core/comments.cjs");
const { chooseOption } = require("./core/choose.cjs");
const { LEGACY_CONFIG, treeConfig } = require("./config/legacy.cjs");
const { isScope, configAt, configUnder, scopeRoot } = require("./config/scope.cjs");
const { DraftStore } = require("./store/drafts.cjs");
const { inbox } = require("./review/inbox.cjs");
const { review } = require("./review/checks.cjs");
const { summarize } = require("./review/summary.cjs");
const { renderText, renderTemplate } = require("./render/text.cjs");
const { renderStaticHtml, snapshotPayload } = require("./render/static.cjs");
const { parseYaml, stringifyYaml } = require("./yaml.cjs");
const { validateTemplate } = require("./templates/schema.cjs");
const { loadTemplate, listTemplates, templateDirs } = require("./templates/lookup.cjs");
const { resolveTemplate } = require("./templates/resolve.cjs");
const { resolveSubtree, expandSubtrees, resolveMode } = require("./templates/subtrees.cjs");
const { openDraft, setDraftConfig, saveDraft } = require("./templates/drafts.cjs");
const { applyTemplate, applyNodes, addSubtree } = require("./templates/apply.cjs");
const { treeToTemplate, exportTemplate } = require("./templates/export.cjs");
const { createMode, saveTreeAsMode, removeMode } = require("./templates/modes.cjs");
const { builtinTemplatesDir, userTemplatesDir } = require("./paths.cjs");
const { App } = require("./http/app.cjs");
const { createServer } = require("./http/server.cjs");
const { parseCli } = require("./cli/args.cjs");
const { installSkill } = require("./cli/install-skill.cjs");
const { main } = require("./cli/main.cjs");

module.exports = {
  VERSION: constants.VERSION,
  SCHEMA_VERSION: constants.SCHEMA_VERSION,
  TEMPLATE_VERSION: constants.TEMPLATE_VERSION,
  NODE_TYPES: constants.NODE_TYPES,
  KINDS: constants.KINDS,
  STATUSES: constants.STATUSES,
  TREE_STATUSES: constants.TREE_STATUSES,
  LINK_TYPES: constants.LINK_TYPES,
  AUTHOR_TYPES: constants.AUTHOR_TYPES,
  LEGACY_CONFIG, treeConfig, isScope, configAt, configUnder, scopeRoot,
  DTError, Store, DraftStore, App, findProjectRoot, scanProjects, slugify, validateSlug,
  addNode: tree.addNode,
  updateNode: tree.updateNode,
  moveNode: tree.moveNode,
  deleteNode: tree.deleteNode,
  lockNode: tree.lockNode,
  chooseOption,
  addLink: tree.addLink,
  removeLink: tree.removeLink,
  updateTreeMeta: tree.updateTreeMeta,
  addComment: comments.addComment,
  resolveComment: comments.resolveComment,
  threadRoot: comments.threadRoot,
  threads: comments.threads,
  inbox, review, summarize, renderText, renderStaticHtml, snapshotPayload,
  createServer, installSkill, parseCli, main,
  parseYaml, stringifyYaml, validateTemplate, loadTemplate, resolveTemplate, listTemplates, templateDirs,
  resolveMode, resolveSubtree, expandSubtrees, applyTemplate, applyNodes, addSubtree, treeToTemplate, exportTemplate, renderTemplate, createMode, saveTreeAsMode, removeMode,
  openDraft, setDraftConfig, saveDraft,
  builtinTemplatesDir, userTemplatesDir,
};
