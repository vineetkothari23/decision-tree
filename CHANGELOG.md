# Release notes

What's new in each version of decision-tree, written for people who use it rather than people who work on its code.

Update with `npx @vineetkothari23/decision-tree@latest`, or reinstall the skill (`npx skills@latest add vineetkothari23/decision-tree`).

## 0.4.0

**A plan can now hold one sub-plan per feature.**

- **Sub-trees.** A node can now be a whole tree of its own. A project plan can hold a separate feature-planning tree for each feature, all in one file. Each sub-tree follows its own mode's rules (statuses, fields, question types) without affecting the rest of the plan. For example, "pending" and pros/cons can be used inside a feature even if the top-level plan doesn't use them.
- **New built-in `planning` mode.** It starts with "Which features make up this project?" and one example feature, ready to rename. Add more features with `dtree add <tree> -p <question> -t tree --mode feature-planning --title "Feature: X"`, or with **+ tree** in the viewer, which lets you pick the mode.
- **Any mode can include another.** In a mode's YAML, add a node with `type: tree` and `mode: <name>`. When a tree is created, that node is filled in with the other mode's questions. To use your own questions there instead, give the node `children:`.
- **Modes stay easy to edit.** In the mode editor, an included mode shows as a single collapsed node with a link to edit that mode on its own, so the screen doesn't fill up with its contents.
- **Reviews check each feature separately.** `dtree review` reports, for example, "s3: no why questions asked yet" for the feature that's missing them.
- **Safer moves.** Moving a node into or out of a feature is refused if it doesn't fit the rules there (for example a status or field that mode doesn't have). The error tells you what to change.
- `feature-planning` still works on its own: `dtree new "X" --mode feature-planning`.
- Existing trees keep working unchanged.

## 0.3.0 (2026-10-04)

**Modes are now fully configurable, and nodes can be locked.**

- **A lean `default` mode.** New blank trees start simple: a description field, the statuses active, accepted and rejected, one link type (`relates-to`), and threaded comments.
- **Modes can build on each other.** A mode can say `extends: <other mode>` and list only what's different. `feature-planning` builds on `default` and adds pros and cons, rationale, assignee, more link types, why/what/how/where question types and a "pending" status for questions waiting on a person.
- **Make it your own.** A mode can define its own statuses, fields (short text, long text or lists), link types and labels (such as "frontend" or "backend").
- **Locks.** Lock a node so nobody adds new nodes directly under it, or anywhere below it. Comments and status changes still work on a locked node.
- **Mode editor in the viewer.** **+ mode** opens a new mode the same way you'd review a tree, with a "+" button to add questions, statuses, fields, link types and labels.
- **Save as template.** Turn any tree into a reusable mode from its overview in the viewer. It then appears in the **+ tree** picker.
- Every tree keeps a copy of its mode's settings, so read-only snapshots keep working even if the mode is later changed or deleted.
- Trees created before 0.3.0 keep working exactly as before.

## 0.2.0 (2026-10-02)

**Start a tree from a template.**

- **Built-in templates.** `feature-planning` seeds why/who/what/how/where/when questions for a new feature. `pr-review` gives a checklist for reviewing a pull request.
- **Your own templates.** Write a template in YAML, register it with `dtree create-mode <name> --yaml <file>`, and use it with `dtree new "Title" --mode <name>`. Remove one with `dtree remove-mode`.
- **Reuse an existing tree.** `dtree template export` turns an existing tree into a template.
- **Template picker in the viewer.** The **+ tree** form lets you choose a template.

## 0.1.2 (2026-10-02)

**Security and comment fixes.**

- The local viewer now refuses changes coming from other websites open in your browser. Before this, a malicious page could edit your trees through the local server.
- Replies to replies now show up everywhere: the viewer, snapshots, the inbox and reviews.

## 0.1.1 (2026-10-02)

- Packaging-only release; nothing changed in how it works.

## 0.1.0 (2026-10-02)

**First release.**

- Plan features as trees of questions (why, what, how, where), options with pros and cons, decisions, tasks and notes.
- Each app keeps its trees as JSON files in its own `.decisions/` folder.
- `dtree` is the command-line tool that agents use to build and update trees.
- `dtree serve` opens a local viewer where people and agents comment, change statuses, and see what's waiting on whom.
- `dtree render` saves a read-only HTML snapshot to share.
- Install as an agent skill (skills.sh, Claude Code plugin, Devin plugin) or from npm.
