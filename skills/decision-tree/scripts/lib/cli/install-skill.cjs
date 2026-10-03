"use strict";

/** Copying the agent skill into a project. */

const fs = require("node:fs");
const path = require("node:path");
const { PACKAGE_NAME } = require("../constants.cjs");
const { SKILL_DIR } = require("../paths.cjs");
const { DTError } = require("../util.cjs");

function installSkill(dir, force) {
  if (!fs.existsSync(path.join(SKILL_DIR, "SKILL.md"))) {
    throw new DTError(`SKILL.md not found next to this script; run \`npx ${PACKAGE_NAME} install-skill\` instead`);
  }
  const dest = path.join(path.resolve(dir), "decision-tree");
  if (fs.existsSync(dest)) {
    if (!force) throw new DTError(`${dest} already exists; pass --force to overwrite`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(SKILL_DIR, dest, { recursive: true });
  return dest;
}

module.exports = { installSkill };
