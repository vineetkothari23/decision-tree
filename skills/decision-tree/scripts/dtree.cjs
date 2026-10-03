#!/usr/bin/env node
/*
 * dtree: question-driven decision trees for planning software features.
 *
 * Trees live as JSON files in <app>/.decisions/<tree-slug>.json. Agents use the
 * CLI; humans use the HTML viewer served by `dtree serve`. Node >= 18, no dependencies.
 * The implementation lives in ./lib/ (see lib/index.cjs for the public API).
 */
"use strict";

const lib = require("./lib/index.cjs");

module.exports = lib;

if (require.main === module) {
  const code = lib.main();
  if (code !== 0) process.exitCode = code;
}
