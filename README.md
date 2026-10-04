# decision-tree

Question-driven decision trees for planning software features. Agents build a tree of
**why / what / how / where** questions, enumerate options with pros and cons, and record the
chosen path with its rationale. Humans review, comment, and steer the same tree in a browser.

- **Storage:** each application keeps its own `.decisions/` folder, with one JSON file per feature tree.
- **Agent CLI:** `dtree` (a single Node.js file with no dependencies; Node >= 18).
- **Human viewer:** `dtree serve` opens a local web app that lists every tree, with graph, outline,
  and activity views, threaded comments, status editing, and "waiting on human / waiting on agent" queues.
- **Snapshots:** `dtree render -o tree.html` writes a self-contained, read-only HTML file.

## Install

### The skill

**Any agent (Claude Code, Codex, Cursor, OpenCode, ...)** via [skills.sh](https://skills.sh):

```bash
npx skills@latest add vineetkothari23/decision-tree
```

**Claude Code plugin:**

```bash
claude plugin marketplace add vineetkothari23/decision-tree
claude plugin install decision-tree@vineetkothari23
```

**Devin:** install this repo as a plugin (it contains `.devin-plugin/plugin.json`).

**npm:** the package bundles the skill under `skills/decision-tree/`, so
[`skills-npm`](https://github.com/antfu/skills-npm) picks it up from `node_modules`, or copy it explicitly:

```bash
npx @vineetkothari23/decision-tree install-skill                       # ./.agents/skills/decision-tree
npx @vineetkothari23/decision-tree install-skill --dir .claude/skills  # or any skills directory
```

### The CLI

The skill carries its own copy of the CLI (`scripts/dtree.cjs`), so agents need only Node >= 18.
To use it directly:

```bash
npx @vineetkothari23/decision-tree --help        # run without installing
npm install -g @vineetkothari23/decision-tree    # provides `dtree` and `decision-tree`
```

## Quick start

```bash
cd /path/to/your-app
dtree init                                   # creates .decisions/ and vendors the tool into .decisions/_tool/
dtree new "Add SSO login" -d "Enterprise customers need SSO"   # or: --template feature-planning
dtree add add-sso-login -p g1 -k why --title "Why do we need SSO now?"
dtree add add-sso-login -p g1 -k how --title "Which protocol?"
dtree add add-sso-login -p q3 -t option --title "OIDC" --pro "Modern, simple" --con "Some IdPs SAML-only"
dtree add add-sso-login -p q3 -t option --title "SAML" --pro "Universal" --con "XML, complex"
dtree choose add-sso-login o4 -r "Covers 90% of customers"
dtree review add-sso-login                   # gaps: unasked why/what/how/where, single-option questions, ...
dtree inbox                                  # human comments awaiting an agent reply
dtree serve --port 8765 --scan ~/code        # browse all trees across apps in the browser
```

Once `init` has run, anyone with Node can use the vendored copy: `node .decisions/_tool/dtree.cjs serve`.

See [`skills/decision-tree/SKILL.md`](skills/decision-tree/SKILL.md) for the full agent workflow and command reference.

## Templates

A template is a YAML (or JSON) file that seeds a **new** tree with predefined questions, options,
tasks and notes under the root goal. Trees are still stored as JSON in `.decisions/<slug>.json`;
YAML is only the authoring format.

```bash
dtree templates                                        # list templates (alias: dtree modes)
dtree template show feature-planning                   # print a template's outline
dtree new "Add SSO login" --template feature-planning  # create a tree from a template by name
dtree new "Review PR 42" --template ./my-review.yaml   # ... or from a file path
dtree template export add-sso-login -o sso.yaml        # turn an existing tree into a template
dtree init --templates                                 # adds .decisions/templates/example.yaml
```

The new tree records `"template": "<name>"` and a `template` activity entry; the template's
`description` becomes the tree description unless you pass `-d`.

### Where templates come from

`--template <name-or-path>` takes the first match:

1. a **file path**, if the argument contains `/` or ends in `.yaml` / `.yml` / `.json` (relative to the current directory);
2. **project** templates: `<app-root>/.decisions/templates/<name>.{yaml,yml,json}` (commit them with the app);
3. **user** templates: each directory in `$DTREE_TEMPLATES_PATH` (`:`-separated, `;` on Windows),
   then `${XDG_CONFIG_HOME:-~/.config}/decision-tree/templates/`;
4. **built-in** templates shipped with the skill in `skills/decision-tree/templates/`
   (e.g. `feature-planning`, `pr-review`); `dtree init` also vendors them into `.decisions/_tool/templates/`.

Project and user templates shadow built-ins with the same name; `dtree templates` lists every
template it finds, marks the one `--template <name>` uses with `*`, and shows what shadows the rest.

### Format (version 1)

The file name (without extension) is the template name: lowercase letters, digits, `-` and `_`.

```yaml
template: 1                    # required, format version
name: api-change               # required, must match the file name
title: Plan an API change      # required, shown in `dtree templates`
description: |                 # optional; the tree description when `dtree new` has no -d
  Breaking or additive change to a public API.
tree_status: draft             # optional: draft|active|decided|implemented|archived
nodes:                         # required, non-empty; added under the root goal g1, in order
  - title: Who calls this API today?
    kind: who                  # questions only: why|what|how|where|who|when|risk|other
    body: |                    # optional guidance for whoever answers it
      - List internal and external callers.
  - title: How do we roll it out?
    kind: how
    children:                  # optional, same shape, any depth
      - title: Versioned endpoint
        type: option           # question (default)|option|decision|task|note — never goal
        pros: [No breakage]    # options only
        cons: [Two code paths]
  - title: Update the changelog
    type: task
    status: open               # optional, any node status (default open)
    assignee: agent            # optional free text
```

Unknown keys, `type: goal`, a `kind` on a non-question, `pros`/`cons` on a non-option, bad
statuses and missing titles are rejected with the template name and node path
(e.g. `nodes[2].children[0]: missing required "title"`).

The YAML parser is built in (no dependencies) and supports only this subset: `#` comments,
`key: value` mappings, `- item` lists, plain / `'single'` / `"double"` quoted strings
(`\n \t \" \\`), integers, `true`/`false`, `null`/`~`, one-line lists like `[a, "b, c"]`, `[]`, `{}`,
and `|` / `>` block text (with `-` / `+` chomping). Anchors, aliases, tags, multiple documents,
flow mappings and `? ` keys are rejected with `file:line` errors; indent with spaces, not tabs.

### Mode config

Templates with `extends:` or `config:` also configure the tree: its fields, statuses (each with a
role), link types, labels, question kinds, review checks and comment threading. See
[`skills/decision-tree/templates/README.md`](skills/decision-tree/templates/README.md#mode-config)
for the format, inheritance rules and the built-in `default` mode. `dtree config <tree>` shows a
tree's settings; `dtree lock <tree> <node> [--scope children|subtree]` / `dtree unlock` stop new
branches; `--label` and `--field id=value` on `add`/`update` set labels and custom fields.

### Custom modes

"Modes" are templates you register yourself. `create-mode` validates the file with the same rules
as `--template` (nothing is written if it is invalid), sets its `name:` to the mode name, and saves it:

```bash
dtree create-mode custom-planning --yaml ./custom-planning.yaml          # .decisions/templates/custom-planning.yaml
dtree create-mode custom-planning --yaml ./custom-planning.yaml --user   # ~/.config/decision-tree/templates/
dtree create-mode custom-planning --yaml ./v2.yaml --force               # overwrite an existing mode
dtree modes                                                              # same as `dtree templates`
dtree new "Plan billing v2" --mode custom-planning                       # --mode is an alias of --template
dtree remove-mode custom-planning [--user]                               # built-in templates can't be removed
```

A project or user mode with a built-in's name shadows it (`dtree modes` shows which one wins).
The viewer's "+ tree" dialog offers every available template, and "Save as template" on a tree's
overview saves its questions, options and nesting (not statuses, comments or history) as a project
mode in `.decisions/templates/<name>.yaml`. "+ mode" in the sidebar opens a mode draft that you
edit exactly like a tree, plus a settings panel with a "+" row per section; "Save mode" writes it.

## Layout

```
skills/decision-tree/SKILL.md                 agent instructions (workflow + command reference)
skills/decision-tree/scripts/dtree.cjs        npm bin + package entry; re-exports lib/index.cjs
skills/decision-tree/scripts/lib/             implementation, one concern per module:
  constants.cjs, paths.cjs, util.cjs            vocabularies/versions, tool file locations, shared helpers
  core/tree.cjs, core/comments.cjs              tree data operations (nodes, links, meta) and comment threads
  store/                                        .decisions/ files, write lock, project discovery, _tool vendoring
  review/                                       inbox, review checks, per-tree summaries
  render/                                       CLI text outlines, static HTML snapshots
  yaml.cjs                                      dependency-free YAML subset parser/serializer
  templates/                                    template schema, lookup, apply, export, modes
  http/                                         API route table, server (Host/Origin checks), project set
  cli/                                          argument specs, command handler tables, main
skills/decision-tree/scripts/viewer.html      single-file viewer (no external dependencies)
skills/decision-tree/templates/               built-in tree templates (YAML)
.devin-plugin/plugin.json                     Devin plugin manifest
.claude-plugin/                               Claude Code plugin + single-plugin marketplace
test/                                         node:test suite
```

## Development

```bash
npm install
npm test
npm run lint
```

Releases: bump `version` in `package.json`, `.claude-plugin/plugin.json` and `VERSION` in `scripts/lib/constants.cjs`, then push a `v<version>` tag;
the publish workflow runs tests and publishes to npm (requires the `NPM_TOKEN` repository secret).

## License

MIT
