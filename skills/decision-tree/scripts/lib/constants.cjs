"use strict";

/** Format versions, vocabularies and limits shared across modules. */

const VERSION = "0.2.0";
const SCHEMA_VERSION = 1;
const DECISIONS_DIR = ".decisions";
const TOOL_DIR = "_tool";
const SCRIPT_NAME = "dtree.cjs";
const LIB_DIR_NAME = "lib";
const PACKAGE_NAME = "@vineetkothari23/decision-tree";

const NODE_TYPES = { goal: "g", question: "q", option: "o", decision: "d", task: "t", note: "n" };
const KINDS = ["why", "what", "how", "where", "who", "when", "risk", "other"];
const STATUSES = ["open", "exploring", "needs-input", "blocked", "decided", "chosen", "rejected", "deferred", "done"];
const TREE_STATUSES = ["draft", "active", "decided", "implemented", "archived"];
const LINK_TYPES = ["depends-on", "blocks", "relates-to", "supersedes", "duplicates"];
const AUTHOR_TYPES = ["agent", "human"];
const EDITABLE_NODE_FIELDS = ["title", "body", "kind", "status", "pros", "cons", "rationale", "assignee", "type"];
const ACTIVITY_LIMIT = 500;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const CLOSED_STATUSES = new Set(["decided", "chosen", "rejected", "deferred", "done"]);
const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_MS = 30000;
const SCAN_SKIP = new Set(["node_modules", ".git", "venv", ".venv", "__pycache__", "dist", "build", "target"]);

const TEMPLATE_VERSION = 1;
const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TEMPLATE_EXTS = [".yaml", ".yml", ".json"];
const TEMPLATES_DIR = "templates";
const DRAFTS_DIR = "_drafts";
const TEMPLATE_KEYS = ["template", "name", "title", "description", "extends", "tree_status", "config", "nodes"];
const TEMPLATE_NODE_KEYS = [
  "title", "type", "kind", "body", "status", "assignee", "pros", "cons", "rationale", "labels", "lock", "fields", "children",
];
const TEMPLATE_PATH_RE = /[\\/]|\.(ya?ml|json)$/i;

const meta = () => ({
  node_types: Object.keys(NODE_TYPES),
  kinds: KINDS,
  statuses: STATUSES,
  tree_statuses: TREE_STATUSES,
  link_types: LINK_TYPES,
});

module.exports = {
  VERSION, SCHEMA_VERSION, DECISIONS_DIR, TOOL_DIR, SCRIPT_NAME, LIB_DIR_NAME, PACKAGE_NAME,
  NODE_TYPES, KINDS, STATUSES, TREE_STATUSES, LINK_TYPES, AUTHOR_TYPES, EDITABLE_NODE_FIELDS, ACTIVITY_LIMIT, SLUG_RE,
  CLOSED_STATUSES, LOCK_TIMEOUT_MS, STALE_LOCK_MS, SCAN_SKIP,
  TEMPLATE_VERSION, TEMPLATE_NAME_RE, TEMPLATE_EXTS, TEMPLATES_DIR, DRAFTS_DIR, TEMPLATE_KEYS, TEMPLATE_NODE_KEYS, TEMPLATE_PATH_RE,
  meta,
};
