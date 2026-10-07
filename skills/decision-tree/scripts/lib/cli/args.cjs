"use strict";

/** CLI usage text, option specs and argument parsing. */

const { parseArgs } = require("node:util");
const { VERSION, AUTHOR_TYPES } = require("../constants.cjs");

const USAGE = `dtree ${VERSION} - question-driven decision trees stored in .decisions/

usage: dtree <command> [options]

  init [--refresh-tool] [--templates]         create .decisions/ and vendor the tool into .decisions/_tool/
                                              (--templates: also .decisions/templates/example.yaml)
  list                                        list trees in the project
  new "<title>" [--id slug] [-d desc] [--template name|path]
                                              create a tree for a feature, optionally seeded from a template
                                              (--mode is an alias of --template)
  templates                                   list templates (project > user > built-in); alias: modes
  template show <name|path>                   print a template's outline
  template export <tree> -o <file.yaml|dir> [--name N]
                                              save a tree's structure as a reusable template
  create-mode <name> --yaml <file> [--user] [--force]
                                              validate a template and save it as .decisions/templates/<name>.yaml
                                              (--user: ~/.config/decision-tree/templates/)
  remove-mode <name> [--user]                 delete a project (or --user) template
  config [<tree>] [--mode name]               a tree's (or mode's) statuses, fields, link types, kinds, labels
  show <tree> [--body]                        print a tree
  node <tree> <node>                          print one node with its comment threads
  add <tree> -p <parent> [-t question|option|decision|task|note] [-k kind] --title T
      [-b body] [-s status] [--pro P]... [--con C]... [--assignee A] [--label L]... [--field id=V]...
      [--lock children|subtree]
  add <tree> -p <parent> -t tree --mode <name> --title T
                                              add a sub-tree node seeded from a mode; nodes below it use that mode's config
  update <tree> <node> [--title T] [-b body] [-k kind] [-t type] [-s status] [--pro P]...
      [--con C]... [-r rationale] [--assignee A] [--label L]... [--field id=V]... [--parent new-parent]
                                              (--label replaces the node's labels; --label "" clears them)
  status <tree> <node> <status>               set node status
  choose <tree> <option> [-r rationale] [--keep-siblings]
  comment <tree> <node> "<text>" [--reply-to cID]
  resolve <tree> <node> <cID> [--reopen]
  link <tree> <src> <dst> [--type T]          default type: the tree's first link type
  lock <tree> <node> [--scope children|subtree]
                                              block adding/moving/deleting direct children (default) or anything below
  unlock <tree> <node>
  unlink <tree> <src> <dst>
  delete <tree> <node>                        delete a node and its subtree
  set-tree <tree> [--title T] [-d desc] [--status draft|active|decided|implemented|archived]
  inbox [tree] [--for agent|human]            items waiting on agents (default) or humans
  review <tree>                               gaps: unasked why/what/how/where, <2 options, ...
  serve [--port 8765] [--host 127.0.0.1] [--scan DIR]... [--extra-project DIR]...
  render -o out.html [--tree slug]            self-contained read-only HTML snapshot
  install-skill [--dir DIR] [--force]         copy the agent skill to DIR/decision-tree
                                              (default DIR: ./.agents/skills)

global options: -C/--project <app-root>  --author NAME  --as agent|human  --json  -h/--help  -V/--version
statuses, kinds, fields, labels and link types come from the tree's mode: run \`dtree config <tree>\`
env: DTREE_AUTHOR, DTREE_AUTHOR_TYPE, DTREE_VERBOSE, DTREE_TEMPLATES_PATH, XDG_CONFIG_HOME
`;

const S = { type: "string" };
const B = { type: "boolean" };
const GLOBAL_OPTS = {
  project: { ...S, short: "C" },
  author: S,
  as: S,
  json: B,
  help: { ...B, short: "h" },
  version: { ...B, short: "V" },
};
const COMMANDS = {
  init: { opts: { "refresh-tool": B, templates: B } },
  list: {},
  new: { args: ["title"], opts: { id: S, description: { ...S, short: "d" }, template: S, mode: S } },
  templates: {},
  modes: {},
  template: { args: ["action", "target?"], opts: { out: { ...S, short: "o" }, name: S } },
  "create-mode": { args: ["name"], required: ["yaml"], opts: { yaml: S, user: B, force: B } },
  "remove-mode": { args: ["name"], opts: { user: B } },
  config: { args: ["tree?"], opts: { mode: S } },
  show: { args: ["tree"], opts: { body: B } },
  node: { args: ["tree", "node"] },
  add: {
    args: ["tree"],
    required: ["parent", "title"],
    opts: {
      parent: { ...S, short: "p" },
      type: { ...S, short: "t" },
      mode: S,
      kind: { ...S, short: "k" },
      title: S,
      body: { ...S, short: "b" },
      status: { ...S, short: "s" },
      pro: { ...S, multiple: true },
      con: { ...S, multiple: true },
      assignee: S,
      label: { ...S, multiple: true },
      field: { ...S, multiple: true },
      lock: S,
    },
  },
  update: {
    args: ["tree", "node"],
    opts: {
      title: S,
      body: { ...S, short: "b" },
      kind: { ...S, short: "k" },
      type: { ...S, short: "t" },
      status: { ...S, short: "s" },
      pro: { ...S, multiple: true },
      con: { ...S, multiple: true },
      rationale: { ...S, short: "r" },
      assignee: S,
      label: { ...S, multiple: true },
      field: { ...S, multiple: true },
      parent: S,
    },
  },
  status: { args: ["tree", "node", "status"] },
  choose: { args: ["tree", "option"], opts: { rationale: { ...S, short: "r" }, "keep-siblings": B } },
  comment: { args: ["tree", "node", "text"], opts: { "reply-to": S } },
  resolve: { args: ["tree", "node", "comment"], opts: { reopen: B } },
  link: { args: ["tree", "src", "dst"], opts: { type: S } },
  lock: { args: ["tree", "node"], opts: { scope: S } },
  unlock: { args: ["tree", "node"] },
  unlink: { args: ["tree", "src", "dst"] },
  delete: { args: ["tree", "node"] },
  "set-tree": { args: ["tree"], opts: { title: S, description: { ...S, short: "d" }, status: S } },
  inbox: { args: ["tree?"], opts: { for: S } },
  review: { args: ["tree"] },
  serve: { opts: { port: S, host: S, scan: { ...S, multiple: true }, "extra-project": { ...S, multiple: true } } },
  render: { required: ["out"], opts: { out: { ...S, short: "o" }, tree: S } },
  "install-skill": { opts: { dir: S, force: B } },
};

class UsageError extends Error {}

const TEXT_OPTS = ["body", "description", "rationale"];

/** Rewrites `-b -text` as `--body=-text` so free-text values may start with "-". */
function joinTextValues(argv, opts) {
  const flags = new Map();
  for (const name of TEXT_OPTS) {
    if (!opts[name]) continue;
    flags.set(`--${name}`, name);
    if (opts[name].short) flags.set(`-${opts[name].short}`, name);
  }
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const name = flags.get(argv[i]);
    if (name && i + 1 < argv.length && argv[i + 1].startsWith("-") && argv[i + 1] !== "--") {
      out.push(`--${name}=${argv[++i]}`);
    } else out.push(argv[i]);
  }
  return out;
}

function parseCli(argv) {
  const takesValue = new Set(["-C", "--project", "--author", "--as"]);
  let idx = -1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (takesValue.has(argv[i])) i++;
    else if (!argv[i].startsWith("-")) {
      idx = i;
      break;
    }
  }
  const cmd = idx >= 0 ? argv[idx] : null;
  if (cmd !== null && !Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
    throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
  }
  const spec = cmd ? COMMANDS[cmd] : {};
  const rest = joinTextValues(idx >= 0 ? [...argv.slice(0, idx), ...argv.slice(idx + 1)] : argv, spec.opts || {});
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTS, ...(spec.opts || {}) }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const o = parsed.values;
  const opts = { cmd, help: Boolean(o.help), version: Boolean(o.version), json: Boolean(o.json), values: o };
  if (!cmd || opts.help || opts.version) return opts;
  const names = spec.args || [];
  const minArgs = names.filter((n) => !n.endsWith("?")).length;
  const pos = parsed.positionals;
  if (pos.length < minArgs) throw new UsageError(`${cmd}: missing <${names[pos.length].replace("?", "")}>`);
  if (pos.length > names.length) throw new UsageError(`${cmd}: unexpected argument ${JSON.stringify(pos[names.length])}`);
  names.forEach((n, i) => {
    opts[n.replace("?", "")] = pos[i];
  });
  for (const r of spec.required || []) if (o[r] === undefined) throw new UsageError(`${cmd}: --${r} is required`);
  if (o.as !== undefined && !AUTHOR_TYPES.includes(o.as)) throw new UsageError(`--as must be one of: ${AUTHOR_TYPES.join(", ")}`);
  if (cmd === "new" && o.template !== undefined && o.mode !== undefined) {
    throw new UsageError("new: use either --template or --mode (they are aliases), not both");
  }
  if (cmd === "template") {
    if (!["show", "export"].includes(opts.action)) throw new UsageError(`template: unknown action ${JSON.stringify(opts.action)} (use show or export)`);
    if (opts.target === undefined) throw new UsageError(`template ${opts.action}: missing <${opts.action === "show" ? "name" : "tree"}>`);
    if (opts.action === "export" && o.out === undefined) throw new UsageError("template export: -o/--out is required");
  }
  return opts;
}

module.exports = { USAGE, COMMANDS, UsageError, parseCli };
