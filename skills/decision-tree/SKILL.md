---
name: decision-tree
description: Plan software features as question-driven decision trees (goals, why/what/how/where questions, options with pros/cons, statuses, comment threads) stored as JSON in each app's .decisions/ folder, with a local HTML viewer where humans and agents comment and coordinate.
---

# decision-tree

Use this skill whenever you plan a feature, design change, or any non-trivial technical choice. Instead of jumping to an implementation, build a **decision tree**: question everything (why / what / how / where / who / when / risk), enumerate options for each question, weigh them, and record the chosen path with its rationale. Humans review and steer the same tree in a browser.

## Storage model

- Each application has its own `<app-root>/.decisions/` folder (commit it with the app).
- One JSON file per feature tree: `.decisions/<tree-slug>.json`.
- `.decisions/_tool/` holds a vendored copy of the tool (`dtree.cjs`, `lib/`, `viewer.html`, built-in `templates/`) so anyone can run it without this skill. `.decisions/templates/` holds the project's own tree templates.
- Node types: `goal` (root, one per tree), `question`, `option`, `decision`, `task`, `note`. Question kinds: `why what how where who when risk other`.
- A tree's node statuses, fields, link types, labels and question kinds come from its mode: run `dt config <tree>` before editing. `feature-planning` uses `active pending accepted rejected` (pending = waiting on a human); `default` uses `active accepted rejected`. Trees without a mode use `open exploring needs-input blocked decided chosen rejected deferred done`. Tree statuses: `draft active decided implemented archived`.
- Every node has: `title`, the mode's fields (built-ins `body`, `pros[]`, `cons[]`, `rationale`, `assignee`; others under `fields`), optional `labels[]` and `lock`, `links[]` (typed graph edges), `comments[]` (threaded via `reply_to`, `resolved` flag, `author_type` = `agent` | `human`), `history[]`. Trees also keep an `activity` log and a `revision` counter.
- IDs are short and stable: `g1`, `q2`, `o3`, `c4` (comments share the counter). Never edit the JSON by hand while the server may be running; use the CLI (it locks and writes atomically).

## Locate the tool

The tool is a single dependency-free Node.js script (Node >= 18). Prefer the app's vendored copy, then the one shipped with this skill, then npm:

```bash
DTREE=.decisions/_tool/dtree.cjs
[ -f "$DTREE" ] || DTREE=$(find / -path '*/skills/decision-tree/scripts/dtree.cjs' -not -path '/proc/*' 2>/dev/null | head -1)
if [ -n "$DTREE" ]; then dt() { node "$DTREE" "$@"; }; else dt() { npx -y @vineetkothari23/decision-tree "$@"; }; fi
```

Run from the app root (or pass `-C <app-root>`). Set `DTREE_AUTHOR=<your agent name>` so your entries are attributed. Add `--json` to any command for machine-readable output.

## Workflow (follow in order)

1. **Set up**: `dt init` (creates `.decisions/`, vendors the tool; `--refresh-tool` updates the vendored copy). Then check existing trees: `dt list`. Reuse a tree if the feature already has one.
2. **Create the tree, starting from a template when one fits**: run `dt templates` (alias `dt modes`) and pick the closest match — e.g. `dt new "Add SSO login" --template feature-planning -d "<problem, users, desired outcome, constraints>"` for a feature, or `dt new "Review PR 42" --template pr-review` for a pull-request review. Project templates in `.decisions/templates/` are the team's own conventions; prefer them. With no match, `dt new "<title>" -d "..."` creates a blank tree. Either way it prints the slug and root `g1`; run `dt show <tree> --body` to read the seeded questions and their guidance.
   - A template is a starting point, not a checklist to fill in: answer its questions, delete the ones that don't apply (or reject/close them), and **keep questioning beyond it** (steps 3-5) — every feature has questions no template anticipates.
3. **Question the goal first** — make sure there is at least one question of each core kind under the root (add any the template lacks) before proposing solutions:
   - `why` — why build this, why now, what problem/evidence, what happens if we don't?
   - `what` — what exactly is in/out of scope, what does success look like, what data/APIs?
   - `how` — how will it work, build vs. buy, which approach/library/pattern?
   - `where` — where in the codebase/architecture/UI/infra does it live?
   - plus `who`/`when`/`risk` when relevant (users, owners, sequencing, security, migration, rollback).
   ```bash
   dt add add-sso-login -p g1 -k why --title "Why do we need SSO now?" -b "context / evidence"
   ```
4. **Enumerate options for every question** (aim for 2-4, including "do nothing"/simplest when sensible), each with pros and cons. Investigate the codebase/docs to ground them:
   ```bash
   dt add add-sso-login -p q2 -t option --title "OIDC only" --pro "simple" --con "some IdPs are SAML-only"
   ```
5. **Recurse**: options and decisions spawn follow-up questions (a chosen `how` raises new `where`/`what`/`risk` questions). Keep asking until leaves are concrete enough to implement. Use `task` nodes for concrete implementation steps and `note` nodes for findings.
6. **Decide or escalate**:
   - When evidence clearly favors one option: `dt choose add-sso-login o7 -r "<why, citing evidence/nodes>"` (gives it the mode's accepted status — `chosen` in trees without a mode — rejects open siblings unless `--keep-siblings`, and marks the question accepted/`decided`).
   - When it needs product/business judgment, budget, or the trade-off is close: `dt status add-sso-login q9 pending` (the tree's waiting status; `needs-input` in trees without a mode) and add a comment explaining exactly what you need from the human. Don't guess on these.
   - Use `blocked` + `dt link <tree> qX qY --type depends-on` when one decision waits on another.
7. **Self-review**: `dt review <tree>` lists gaps (missing why/what/how/where, questions with <2 options, options without pros/cons, chosen options without rationale or follow-ups, unanswered human comments). Fix them or justify in a comment.
8. **Coordinate with humans** — at the start of every planning/implementation step:
   - `dt inbox` (all trees) shows threads where a human spoke last and is waiting on agents. Answer each with `dt comment <tree> <node> "<answer>" --reply-to <thread-id>`, update the node (status/options/choice) accordingly, and `dt resolve <tree> <node> <thread-id>` once settled.
   - `dt inbox --for human` shows what humans still need to answer (useful in status updates).
   - Treat human comments as authoritative direction; if they reject a choice, re-open it (`dt status ...` with the tree's open status, e.g. `active` or `exploring`) and re-evaluate.
9. **Show the tree to the human**: `dt show <tree> [--body]` prints an ASCII tree for chat. For the interactive viewer start `dt serve --port 8765` (binds 127.0.0.1; add `--scan ~/repos` to list every app's `.decisions`, or `--extra-project <path>`), keep it running in a background shell, and share it (in Devin, call `browser_preview` with that port). For a static, read-only snapshot to attach to a message or PR: `dt render -o decisions.html [--tree <slug>]`.
10. **Close out**: when the plan is settled set `dt set-tree <tree> --status decided`; after shipping, mark tasks accepted/closed (`done` in trees without a mode) and the tree `implemented`. Commit `.decisions/` with the code so future agents see why things were built this way.

## Templates and custom modes

Templates (also called modes) are YAML files that seed a new tree with questions, options, tasks and notes under the root goal. `dt new --template <name>` (or `--mode <name>`) looks up, first match wins: a file path (argument contains `/` or ends in `.yaml/.yml/.json`), the project's `.decisions/templates/<name>.yaml`, each dir in `$DTREE_TEMPLATES_PATH`, `~/.config/decision-tree/templates/` (`$XDG_CONFIG_HOME`), then the built-ins in this skill's `templates/` (`feature-planning`, `pr-review`). `dt templates` shows every template with its source and which one wins; `dt template show <name>` prints its outline.

### Mode config

A mode may also set the tree's vocabulary with `extends:` and `config:`; only differences from the parent are written:

```yaml
template: 1
name: team-planning
title: Team planning
extends: feature-planning      # optional; a mode with `config:` and no `extends:` extends `default`
config:                        # only what differs from the parent
  fields:                      # keyed: <id>: {name, type}; type is text | text_body | list
    effort:
      name: Effort
      type: text
    assignee: null             # null removes an inherited entry
  statuses:                    # keyed: <id>: {name, role}
    parked:
      name: Parked
      role: closed
  link_types:                  # keyed: <id>: {name}
    implements:
      name: Implements
  labels: [frontend, backend]  # lists replace the parent's list
  kinds: [why, what, how, where, risk]
  review:
    required_kinds: [why, how] # `dtree review` warns when a kind is missing; must be in kinds
  comments:
    threads: false             # flat comments: no replies
nodes:                         # may be empty in a mode that has config; seed nodes are never inherited
  - title: Why now?
    kind: why
    labels: [backend]          # must be in the mode's labels
    fields:                    # custom field values
      effort: 2d
    lock: children             # children | subtree: blocks add/move/delete below it
```

Built-in `default` is lean: field `body`, link type `relates-to`, statuses `active` (open),
`accepted` and `rejected`, threaded comments, no kinds or labels. `feature-planning` and
`pr-review` extend it (adding pros/cons/rationale, more link types, kinds and, for planning,
a `pending` status). Every status has a role: `open` (the first one is the default for new
nodes), `waiting` (shows in the human inbox), `blocked`, `accepted` (choosing an option sets the
last accepted status on it and the first on its parent), `rejected` (its siblings), `closed`.
Each mode needs at least one open, accepted and rejected status. Lookup follows the template
search order; a mode that extends its own name inherits from the next location down (so a
project `default.yaml` with `extends: default` customizes the built-in for every mode). At most
8 modes deep; cycles are rejected. A new tree stores its mode name and the fully resolved config,
so editing or removing the mode later never changes existing trees. Trees created without a mode,
or before modes had config, keep the original fixed vocabulary.

Locks only block structure (add, move, delete); comments, statuses, choosing and field edits still work. Use `dt lock <tree> <node>` when a set of options is final, e.g. the PR-review verdict is seeded locked.

### Custom modes

When the human (or you, after a few similar trees) wants a reusable starting structure, register it as a mode:

```bash
dt create-mode custom-planning --yaml ./custom-planning.yaml           # saves .decisions/templates/custom-planning.yaml
dt create-mode custom-planning --yaml ./custom-planning.yaml --user    # or ~/.config/decision-tree/templates/
dt new "Plan billing v2" --mode custom-planning
dt remove-mode custom-planning [--user]                                # project/user modes only, never built-ins
```

`create-mode` validates the file (nothing is written on error), forces its `name:` to the mode name, and refuses to overwrite an existing mode without `--force`. To capture a real tree's structure as a template: `dt template export <tree> -o ./custom-planning.yaml` (keeps titles, types, kinds, bodies, pros/cons and nesting; drops statuses, comments and history), then `create-mode` it; humans can do the same from the viewer with "Save as template". `dt init --templates` writes a commented `.decisions/templates/example.yaml`.

Format (`template: 1`): top-level `template`, `name` (= file name), `title`, optional `description`, `tree_status`, and a non-empty `nodes` list; each node has `title` and optional `type` (question default, option, decision, task, note — never goal), `kind` (questions only), `body`, `status`, `assignee`, `pros`/`cons` (options only) and `children`. Only a YAML subset is accepted: comments, mappings, `- ` lists, quoted/plain scalars, one-line `[a, b]` lists, `|`/`>` blocks; anchors, aliases, tags, flow mappings and tabs are rejected with `file:line` errors.

## Command reference

```
dt init [--refresh-tool] [--templates]       dt list
dt new "<title>" [--id slug] [-d desc] [--template name|path | --mode name]
dt templates | dt modes                      dt template show <name|path>
dt template export <tree> -o <file.yaml|dir> [--name N]
dt create-mode <name> --yaml <file> [--user] [--force]    dt remove-mode <name> [--user]
dt show <tree> [--body]
dt node <tree> <node>                        (details, threads, history)
dt config [<tree>] [--mode name]             (statuses, fields, link types, kinds, labels in use)
dt add <tree> -p <parent> [-t question|option|decision|task|note] [-k kind] --title T [-b body] [-s status] [--pro P]... [--con C]... [--assignee A] [--label L]... [--field id=V]... [--lock children|subtree]
dt update <tree> <node> [--title] [-b] [-k] [-t] [-s] [--pro]... [--con]... [-r rationale] [--assignee] [--label L]... [--field id=V]... [--parent new-parent]
dt lock <tree> <node> [--scope children|subtree]    dt unlock <tree> <node>
dt status <tree> <node> <status>             dt choose <tree> <option> [-r rationale] [--keep-siblings]
dt comment <tree> <node> "<text>" [--reply-to cID]
dt resolve <tree> <node> <cID> [--reopen]
dt link <tree> <src> <dst> [--type T]        (default: the mode's first link type)   dt unlink <tree> <src> <dst>
dt delete <tree> <node>                      (removes the subtree)
dt set-tree <tree> [--title] [-d] [--status draft|active|decided|implemented|archived]
dt inbox [tree] [--for agent|human]          dt review <tree>
dt serve [--port 8765] [--host 127.0.0.1] [--scan DIR]... [--extra-project DIR]...
dt render -o out.html [--tree slug]
dt install-skill [--dir DIR] [--force]       (copy this skill into DIR/decision-tree; default ./.agents/skills)
global: -C <app-root>  --author NAME  --as agent|human  --json
```

## Web viewer

- Sidebar lists every project and its trees with badges (open questions, needs-input, items waiting on humans/agents). "+ tree" creates a tree, optionally from any available template.
- Graph view (pan by dragging, scroll to zoom, collapse subtrees), outline view, and activity log. Chosen paths are green; rejected options are struck through; `depends-on` links are dashed arrows.
- Clicking a node opens an editor (title, status, type, kind, lock, the mode's fields and labels), "Choose option", a button for the mode's waiting status, add-child buttons, links, threaded comments with reply/resolve, and history. Comments from the browser are recorded as `human` with the name in the "You" box.
- With no node selected, the right panel is a coordination dashboard: waiting on humans, waiting on agents, open questions.
- "+ mode" opens a mode draft (new, extending a mode, or editing/copying one): its seed nodes are edited like any tree and the right panel lists its fields, statuses, link types, labels, kinds, review kinds and comment threading, each with a "+" row. "Save mode" writes `.decisions/templates/<name>.yaml`.
- The page polls every 3 s, so agent CLI changes appear live; if a human is mid-edit they get a reload banner instead of losing work.

## HTTP API (used by the viewer; agents should prefer the CLI)

`GET /api/projects`, `GET /api/meta`, `GET /api/projects/<p>/templates`, `POST /api/projects/<p>/templates` (`tree`, `name`, optional `force`; saves the tree's structure as a project template), `POST /api/projects/<p>/trees` (`title`, `description`, `id`, optional `template` name), `GET|PATCH /api/projects/<p>/trees/<slug>`, `POST .../nodes`, `PATCH|DELETE .../nodes/<id>`, `POST .../nodes/<id>/choose` (node bodies accept the mode's field ids, `fields`, `labels`, `lock`), `GET /api/projects/<p>/templates/<name>` (resolved mode), `GET|POST /api/projects/<p>/drafts` (`name` plus `from` or `extends`), `PATCH .../drafts/<name>/config` (`config`, `extends`), `POST .../drafts/<name>/save` (`force`), `DELETE .../drafts/<name>`; every tree route also works under `drafts/<name>`, `POST .../nodes/<id>/comments`, `PATCH .../nodes/<id>/comments/<cid>`, `POST|DELETE .../nodes/<id>/links`. JSON bodies accept `author` and `author_type`. Requests whose `Origin` doesn't match the server, or whose `Host` isn't `localhost`, an IP address or the `--host` name, are rejected with 403.
