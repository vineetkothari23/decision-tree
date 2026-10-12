# decision-tree

Plan with AI agents in a shared tree. The agent asks why / what / how questions, lists options
with pros and cons, and records what was chosen and why. You review, comment and steer in the browser.

- Trees are JSON files in each app's `.decisions/` folder.
- `dtree` is the CLI agents use (Node 18+, no dependencies).
- `dtree serve` opens a viewer for humans, with graph and outline views, comments, and drag-and-drop to move nodes.
- Modes set up a tree for one use: `decision-tree` (the default), `feature-planning`, `plan`, `pr-review`
  and `vocabulary` (a glossary of repo words). You can write your own in YAML.

## Install

Any agent (Claude Code, Codex, Cursor, OpenCode, ...) via [skills.sh](https://skills.sh):

```bash
npx skills@latest add vineetkothari23/decision-tree
```

Claude Code plugin:

```bash
claude plugin marketplace add vineetkothari23/decision-tree
claude plugin install decision-tree@vineetkothari23
```

Devin: install this repo as a plugin.

npm (CLI, plus the skill under `skills/decision-tree/`):

```bash
npx @vineetkothari23/decision-tree --help                # run without installing
npm install -g @vineetkothari23/decision-tree            # provides `dtree`
npx @vineetkothari23/decision-tree install-skill         # copy the skill to ./.agents/skills/
```

## Quick start

```bash
cd your-app
dtree init
dtree new "Add SSO login" -d "Enterprise customers need SSO"
dtree add add-sso-login -p g1 -k how --title "Which protocol?"
dtree add add-sso-login -p q2 -t option --title "OIDC" --pro "Simple" --con "Some IdPs are SAML-only"
dtree add add-sso-login -p q2 -t option --title "SAML" --pro "Universal" --con "Complex"
dtree choose add-sso-login o3 -r "Covers most customers"
dtree review add-sso-login     # what's missing
dtree serve                    # open the viewer
```

## Modes

```bash
dtree modes                                        # list modes
dtree new "Glossary" --mode vocabulary             # start a tree in a mode
dtree create-mode my-mode --yaml ./my-mode.yaml    # add your own
```

A mode can declare its own node types, fields, statuses, link types and rules.
See [templates/README.md](skills/decision-tree/templates/README.md) for the format.

## More

- [SKILL.md](skills/decision-tree/SKILL.md): agent workflow and all commands.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.
- Development: `npm install`, `npm test`, `npm run lint`.

## License

MIT
