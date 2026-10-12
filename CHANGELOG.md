# Release notes

## 0.5.0

- Modes can define their own node types.
- New `vocabulary` mode: a shared glossary of repo words for humans and agents.
- The code owns only a generic node and tree; goal/question/option/decision/task/note move to the new `decision-tree` mode, the default for `dtree new`.
- `default` mode renamed `base`; `extends: default` still works (as `decision-tree`).
- Node types can set their own fields, statuses, color, root/default role and rules (`level: warn` or `block`).
- Choose and assignee are opt-in mode features.
- Node types without a color get a stable automatic one.
- Drag a node onto another in the viewer to re-parent it.

## 0.4.1

- New `plan` mode: plan a project as a set of feature sub-trees.

## 0.4.0

- Modular templates: reuse other template trees as sub-trees in larger modes.
- Updated `planning` mode for planning several features at once.
- Each sub-tree keeps its own statuses, fields and question types.
- Mode editor shows sub-trees collapsed, with a link to edit them.

## 0.3.0 (2026-10-04)

- Lean `default` mode; other modes extend it and add only what differs.
- Custom statuses, fields, link types and labels per mode.
- Lock a node to stop new branches under it.
- Create and edit modes in the viewer.
- Save any tree as a template from the viewer.

## 0.2.0 (2026-10-02)

- Built-in `feature-planning` and `pr-review` templates.
- Create your own templates in YAML with `dtree create-mode`.
- Pick a template when creating a tree in the viewer.

## 0.1.2 (2026-10-02)

- Security: other websites can no longer edit your trees through the local viewer.
- Replies to replies now show everywhere.

## 0.1.1 (2026-10-02)

- Packaging-only release; no changes.

## 0.1.0 (2026-10-02)

- First release: decision trees in `.decisions/`, the `dtree` CLI, a local viewer and HTML snapshots.
