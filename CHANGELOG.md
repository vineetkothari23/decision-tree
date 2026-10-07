# Release notes

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
