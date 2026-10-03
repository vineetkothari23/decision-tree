"use strict";

/** CLI entry: parse argv, find the project, run the command and print its result. */

const path = require("node:path");
const { VERSION, AUTHOR_TYPES } = require("../constants.cjs");
const { DTError, choice } = require("../util.cjs");
const { Store } = require("../store/store.cjs");
const { findProjectRoot } = require("../store/projects.cjs");
const { USAGE, UsageError, parseCli } = require("./args.cjs");
const { run } = require("./commands.cjs");

function cliAuthor(o) {
  const type = o.as || process.env.DTREE_AUTHOR_TYPE || "agent";
  choice(type, AUTHOR_TYPES, "author type");
  return { name: o.author || process.env.DTREE_AUTHOR || type, type };
}

function main(argv = process.argv.slice(2)) {
  let a;
  try {
    a = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`error: ${e.message}\nrun \`dtree --help\` for usage\n`);
    return 2;
  }
  if (a.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (a.help || !a.cmd) {
    process.stdout.write(USAGE);
    return a.cmd || a.help ? 0 : 2;
  }
  try {
    const root = a.values.project ? path.resolve(a.values.project) : findProjectRoot(process.cwd());
    const result = run(a, new Store(root), cliAuthor(a.values));
    if (result) {
      const [data, text] = result;
      process.stdout.write((a.json ? JSON.stringify(data, null, 2) : text) + "\n");
    }
    return 0;
  } catch (e) {
    if (!(e instanceof DTError) && !(e instanceof SyntaxError)) throw e;
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
}

module.exports = { main };
