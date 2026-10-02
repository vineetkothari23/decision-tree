---
name: decision-tree
description: Plan software features as question-driven decision trees (goals, why/what/how/where questions, options with pros/cons, statuses, comment threads) stored as JSON in each app's .decisions/ folder, with a local HTML viewer where humans and agents comment and coordinate.
---

# decision-tree

Use this skill whenever you plan a feature, design change, or any non-trivial technical choice. Instead of jumping to an implementation, build a **decision tree**: question everything (why / what / how / where / who / when / risk), enumerate options for each question, weigh them, and record the chosen path with its rationale. Humans review and steer the same tree in a browser.

## Storage model

- Each application has its own `<app-root>/.decisions/` folder (commit it with the app).
- One JSON file per feature tree: `.decisions/<tree-slug>.json`.
- `.decisions/_tool/` holds a vendored copy of the tool (`dtree.cjs` + `viewer.html`) so anyone can run it without this skill.
- Node types: `goal` (root, one per tree), `question`, `option`, `decision`, `task`, `note`. Question kinds: `why what how where who when risk other`.
- Node statuses: `open exploring needs-input blocked decided chosen rejected deferred done`. Tree statuses: `draft active decided implemented archived`.
- Every node has: `title`, `body`, `pros[]`, `cons[]`, `rationale`, `assignee`, `links[]` (graph edges: `depends-on blocks relates-to supersedes duplicates`), `comments[]` (threaded via `reply_to`, `resolved` flag, `author_type` = `agent` | `human`), `history[]`. Trees also keep an `activity` log and a `revision` counter.
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
2. **Create the tree**: `dt new "Add SSO login" -d "<problem, users, desired outcome, constraints>"` → prints the slug and root `g1`.
3. **Question the goal first** — add at least one question of each core kind under the root before proposing solutions:
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
   - When evidence clearly favors one option: `dt choose add-sso-login o7 -r "<why, citing evidence/nodes>"` (marks it `chosen`, rejects open siblings unless `--keep-siblings`, marks the question `decided`).
   - When it needs product/business judgment, budget, or the trade-off is close: `dt status add-sso-login q9 needs-input` and add a comment explaining exactly what you need from the human. Don't guess on these.
   - Use `blocked` + `dt link <tree> qX qY --type depends-on` when one decision waits on another.
7. **Self-review**: `dt review <tree>` lists gaps (missing why/what/how/where, questions with <2 options, options without pros/cons, chosen options without rationale or follow-ups, unanswered human comments). Fix them or justify in a comment.
8. **Coordinate with humans** — at the start of every planning/implementation step:
   - `dt inbox` (all trees) shows threads where a human spoke last and is waiting on agents. Answer each with `dt comment <tree> <node> "<answer>" --reply-to <thread-id>`, update the node (status/options/choice) accordingly, and `dt resolve <tree> <node> <thread-id>` once settled.
   - `dt inbox --for human` shows what humans still need to answer (useful in status updates).
   - Treat human comments as authoritative direction; if they reject a choice, re-open it (`dt status ... exploring`) and re-evaluate.
9. **Show the tree to the human**: `dt show <tree> [--body]` prints an ASCII tree for chat. For the interactive viewer start `dt serve --port 8765` (binds 127.0.0.1; add `--scan ~/repos` to list every app's `.decisions`, or `--extra-project <path>`), keep it running in a background shell, and share it (in Devin, call `browser_preview` with that port). For a static, read-only snapshot to attach to a message or PR: `dt render -o decisions.html [--tree <slug>]`.
10. **Close out**: when the plan is settled set `dt set-tree <tree> --status decided`; after shipping, mark tasks `done` and the tree `implemented`. Commit `.decisions/` with the code so future agents see why things were built this way.

## Command reference

```
dt init [--refresh-tool]                     dt list
dt new "<title>" [--id slug] [-d desc]       dt show <tree> [--body]
dt node <tree> <node>                        (details, threads, history)
dt add <tree> -p <parent> [-t question|option|decision|task|note] [-k kind] --title T [-b body] [-s status] [--pro P]... [--con C]... [--assignee A]
dt update <tree> <node> [--title] [-b] [-k] [-t] [-s] [--pro]... [--con]... [-r rationale] [--assignee] [--parent new-parent]
dt status <tree> <node> <status>             dt choose <tree> <option> [-r rationale] [--keep-siblings]
dt comment <tree> <node> "<text>" [--reply-to cID]
dt resolve <tree> <node> <cID> [--reopen]
dt link <tree> <src> <dst> [--type depends-on|blocks|relates-to|supersedes|duplicates]   dt unlink <tree> <src> <dst>
dt delete <tree> <node>                      (removes the subtree)
dt set-tree <tree> [--title] [-d] [--status draft|active|decided|implemented|archived]
dt inbox [tree] [--for agent|human]          dt review <tree>
dt serve [--port 8765] [--host 127.0.0.1] [--scan DIR]... [--extra-project DIR]...
dt render -o out.html [--tree slug]
dt install-skill [--dir DIR] [--force]       (copy this skill into DIR/decision-tree; default ./.agents/skills)
global: -C <app-root>  --author NAME  --as agent|human  --json
```

## Web viewer

- Sidebar lists every project and its trees with badges (open questions, needs-input, items waiting on humans/agents). "+ tree" creates a tree.
- Graph view (pan by dragging, scroll to zoom, collapse subtrees), outline view, and activity log. Chosen paths are green; rejected options are struck through; `depends-on` links are dashed arrows.
- Clicking a node opens an editor (title, status, type, kind, details, pros/cons, rationale, assignee), "Choose option", "Needs input", add-child buttons, links, threaded comments with reply/resolve, and history. Comments from the browser are recorded as `human` with the name in the "You" box.
- With no node selected, the right panel is a coordination dashboard: waiting on humans, waiting on agents, open questions.
- The page polls every 3 s, so agent CLI changes appear live; if a human is mid-edit they get a reload banner instead of losing work.

## HTTP API (used by the viewer; agents should prefer the CLI)

`GET /api/projects`, `GET /api/meta`, `POST /api/projects/<p>/trees`, `GET|PATCH /api/projects/<p>/trees/<slug>`, `POST .../nodes`, `PATCH|DELETE .../nodes/<id>`, `POST .../nodes/<id>/choose`, `POST .../nodes/<id>/comments`, `PATCH .../nodes/<id>/comments/<cid>`, `POST|DELETE .../nodes/<id>/links`. JSON bodies accept `author` and `author_type`. Requests whose `Origin` doesn't match the server, or whose `Host` isn't `localhost`, an IP address or the `--host` name, are rejected with 403.
