"use strict";

/** Where the tool's own files live: the scripts dir (a skill checkout, an npm install, or .decisions/_tool/). */

const os = require("node:os");
const path = require("node:path");
const { SCRIPT_NAME, TOOL_DIR, TEMPLATES_DIR } = require("./constants.cjs");
const { realOrResolved } = require("./util.cjs");

const LIB_DIR = realOrResolved(__dirname);
const SCRIPTS_DIR = path.dirname(LIB_DIR);
const ENTRY_SCRIPT = path.join(SCRIPTS_DIR, SCRIPT_NAME);
const VIEWER_HTML = path.join(SCRIPTS_DIR, "viewer.html");
const SKILL_DIR = path.dirname(SCRIPTS_DIR);

function builtinTemplatesDir() {
  return path.basename(SCRIPTS_DIR) === TOOL_DIR ? path.join(SCRIPTS_DIR, TEMPLATES_DIR) : path.join(SKILL_DIR, TEMPLATES_DIR);
}

function userTemplatesDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "decision-tree", TEMPLATES_DIR);
}

module.exports = { LIB_DIR, SCRIPTS_DIR, ENTRY_SCRIPT, VIEWER_HTML, SKILL_DIR, builtinTemplatesDir, userTemplatesDir };
