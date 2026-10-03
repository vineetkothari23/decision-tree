"use strict";

/** Copies the running tool into <app>/.decisions/_tool/ so the app can run it without the skill installed. */

const fs = require("node:fs");
const path = require("node:path");
const { SCRIPT_NAME, LIB_DIR_NAME, TEMPLATES_DIR } = require("../constants.cjs");
const { LIB_DIR, SCRIPTS_DIR, ENTRY_SCRIPT, VIEWER_HTML, builtinTemplatesDir } = require("../paths.cjs");
const { isDir, realOrResolved } = require("../util.cjs");

function replaceDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  if (isDir(src)) fs.cpSync(src, dest, { recursive: true });
}

/** Vendors into `tool` unless it is the running copy, or already vendored and `refresh` is false. */
function vendorTool(tool, refresh) {
  if (SCRIPTS_DIR === realOrResolved(tool)) return;
  if (!refresh && fs.existsSync(path.join(tool, SCRIPT_NAME))) return;
  fs.mkdirSync(tool, { recursive: true });
  replaceDir(LIB_DIR, path.join(tool, LIB_DIR_NAME));
  replaceDir(builtinTemplatesDir(), path.join(tool, TEMPLATES_DIR));
  fs.copyFileSync(VIEWER_HTML, path.join(tool, "viewer.html"));
  fs.copyFileSync(ENTRY_SCRIPT, path.join(tool, SCRIPT_NAME));
}

module.exports = { vendorTool };
