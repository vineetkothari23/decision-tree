"use strict";

/** Locating application roots that contain a .decisions/ directory. */

const fs = require("node:fs");
const path = require("node:path");
const { DECISIONS_DIR, TOOL_DIR, SCAN_SKIP } = require("../constants.cjs");
const { SCRIPTS_DIR } = require("../paths.cjs");
const { isDir } = require("../util.cjs");

function findProjectRoot(start) {
  let cur = path.resolve(start);
  for (;;) {
    if (isDir(path.join(cur, DECISIONS_DIR))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const here = SCRIPTS_DIR;
  if (path.basename(here) === TOOL_DIR && path.basename(path.dirname(here)) === DECISIONS_DIR) {
    return path.dirname(path.dirname(here));
  }
  return path.resolve(start);
}

function scanProjects(base, maxDepth = 4) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.includes(DECISIONS_DIR)) found.push(dir);
    if (depth >= maxDepth) return;
    for (const d of dirs.sort()) {
      if (!SCAN_SKIP.has(d) && !d.startsWith(".")) walk(path.join(dir, d), depth + 1);
    }
  };
  walk(path.resolve(base), 0);
  return found;
}

module.exports = { findProjectRoot, scanProjects };
