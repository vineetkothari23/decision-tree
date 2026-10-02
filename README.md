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
dtree new "Add SSO login" -d "Enterprise customers need SSO"
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

## Layout

```
skills/decision-tree/SKILL.md                 agent instructions (workflow + command reference)
skills/decision-tree/scripts/dtree.cjs        CLI, JSON store, HTTP API server (npm bin)
skills/decision-tree/scripts/viewer.html      single-file viewer (no external dependencies)
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

Releases: bump `version` in `package.json`, `.claude-plugin/plugin.json` and `VERSION` in `dtree.cjs`, then push a `v<version>` tag;
the publish workflow runs tests and publishes to npm (requires the `NPM_TOKEN` repository secret).

## License

MIT
