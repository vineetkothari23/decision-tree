"use strict";

/**
 * Editing modes through drafts. A draft is a tree whose nodes are the mode's seed nodes and whose `config` is the
 * mode's resolved config, so the viewer and CLI edit it with the same operations as any tree. Saving exports it
 * back to `.decisions/templates/<mode>.yaml` (config as a diff against its parent, statuses kept).
 */

const fs = require("node:fs");
const path = require("node:path");
const { TEMPLATES_DIR } = require("../constants.cjs");
const { DTError } = require("../util.cjs");
const { log } = require("../core/tree.cjs");
const { parseConfig, mergeConfig, finalizeConfig, configFail } = require("../config/sections.cjs");
const { validateTemplateName } = require("./schema.cjs");
const { DEFAULT_MODE, resolveTemplate, inheritedConfig } = require("./resolve.cjs");
const { saveTreeAsMode } = require("./modes.cjs");
const { expandSubtrees } = require("./subtrees.cjs");
const { scopeRoot } = require("../config/scope.cjs");
const { nodeConflicts, summarizeConflicts } = require("../core/policy/conform.cjs");

const projectModesDir = (store) => path.join(store.dir, TEMPLATES_DIR);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Opens (or with `reset`, restarts) the draft for mode `name`: a copy of mode `from`, or a blank mode extending `parent`. */
function openDraft(store, drafts, { name, from = null, parent = null, reset = false }, author) {
  validateTemplateName(name);
  if (fs.existsSync(drafts.treePath(name))) {
    if (!reset) return drafts.load(name);
    drafts.remove(name);
  }
  let tpl;
  let ext;
  if (from) {
    tpl = expandSubtrees(store, resolveTemplate(store, from, { allowPath: false }), { seed: false });
    ext = tpl.resolved_config ? tpl.extends || DEFAULT_MODE : null;
  } else {
    ext = parent || DEFAULT_MODE;
    validateTemplateName(ext);
    const config = inheritedConfig(store, name, ext, projectModesDir(store));
    if (!Object.keys(config).length) throw new DTError(`mode ${JSON.stringify(ext)} not found; run \`dtree modes\` to list them`);
    tpl = { name, title: name, description: "", tree_status: null, nodes: [], resolved_config: clone(config), source: "draft" };
  }
  drafts.createTree(name, tpl.title, tpl.description, author, tpl);
  return drafts.edit(name, (tree) => {
    tree.draft = { mode: name, extends: ext };
    return tree;
  });
}

/** Problems that would make the nodes in `tree`'s file scope (not inside sub-trees) invalid under `cfg`. */
const conflicts = (tree, cfg) =>
  Object.values(tree.nodes).filter((n) => scopeRoot(tree, n.id) === tree.root_id).flatMap((n) => nodeConflicts(n, cfg));

/** Replaces a draft's whole `config` and/or its parent (`extends`); refused if existing nodes would stop conforming. */
function setDraftConfig(store, tree, { config, extends: ext }, author) {
  if (!tree.draft) throw new DTError(`${tree.id} is not a mode draft`);
  if (!tree.config) {
    throw new DTError(`mode ${JSON.stringify(tree.draft.mode)} has no config (a legacy template); add \`extends: default\` to its YAML to configure it`);
  }
  const fail = configFail(`mode ${JSON.stringify(tree.draft.mode)}`);
  const next = config === undefined ? tree.config : finalizeConfig(mergeConfig({}, parseConfig(config, fail)), fail);
  if (ext !== undefined && ext !== tree.draft.extends) {
    validateTemplateName(ext);
    if (!Object.keys(inheritedConfig(store, tree.draft.mode, ext, projectModesDir(store))).length) {
      throw new DTError(`mode ${JSON.stringify(ext)} not found; run \`dtree modes\` to list them`);
    }
  }
  const bad = conflicts(tree, next);
  if (bad.length) {
    throw new DTError(`config change would leave nodes invalid: ${summarizeConflicts(bad)}`);
  }
  tree.config = next;
  if (ext !== undefined) tree.draft.extends = ext;
  log(tree, author, "config", tree.root_id, `mode ${tree.draft.mode}${ext !== undefined ? ` extends ${ext}` : ""}`);
  return tree;
}

/** Writes a draft as the project mode it edits, then discards the draft. */
function saveDraft(store, drafts, slug, { force = false } = {}) {
  const tree = drafts.load(slug);
  if (!tree.draft) throw new DTError(`${slug} is not a mode draft`);
  const res = saveTreeAsMode(store, tree, tree.draft.mode, { force, keepStatus: true });
  drafts.remove(slug);
  return res;
}

module.exports = { openDraft, setDraftConfig, saveDraft };
