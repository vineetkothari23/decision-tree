# Templates

A template seeds a **new** decision tree with predefined nodes under the root goal (`g1`), so
recurring kinds of work start from the same set of questions instead of a blank tree:

```bash
dtree new "Add SSO login" --template feature-planning
dtree new "Review PR 123" --template pr-review -d "https://github.com/org/repo/pull/123"
```

Templates are an authoring format only: the created tree is stored as normal JSON in
`.decisions/<slug>.json`, and after creation it is edited like any other tree.

## Built-in templates

| Name | Use it for | Seeds |
|---|---|---|
| `feature-planning` | Planning a new feature | why, who, scope, success metrics (needs human sign-off), approach, data/API changes, placement, rollout (feature flag vs. big-bang options), testing, security/privacy risk |
| `pr-review` | Reviewing a pull request | intent, scope, approach, edge cases/error handling, placement, risk, tests, docs, and a `Review verdict` decision with Approve / Request changes / Comment only options |

Seeded questions carry a `body` of prompts telling you what to investigate. They are a starting
point: add options with pros and cons for every question, add follow-up questions, delete
questions that do not apply, and still run `dtree review <tree>` before deciding.

## Format (version 1)

File name `<name>.yaml` (or `.yml` / `.json`); the template name is the file name without the
extension, using lowercase letters, digits, `-` and `_`.

```yaml
template: 1                  # required: format version
name: my-template            # required: must match the file name
title: Plan a migration      # required: label shown in `dtree templates`
description: |               # optional: tree description when `dtree new` gets no -d
  ...
tree_status: draft           # optional: draft|active|decided|implemented|archived
nodes:                       # required, non-empty; attached under the root goal
  - title: Why migrate now?  # required
    type: question           # optional, default question: question|option|decision|task|note
    kind: why                # optional, questions only: why|what|how|where|who|when|risk|other
    body: |                  # optional prompts or guidance
      - What breaks if we stay?
    status: open             # optional node status, default open (e.g. needs-input)
    assignee: human          # optional free text
    pros: [Fast to ship]     # optional, options only
    cons: [Needs migration]  # optional, options only
    children:                # optional, same shape, any depth
      - title: ...
```

Only a YAML subset is accepted: comments, block mappings and sequences (indented with spaces),
plain/quoted scalars, integers, booleans, `null`, one-line flow sequences of scalars (`[a, "b, c"]`),
and `|` / `>` block scalars. Anchors, aliases, tags, multiple documents, flow mappings, and complex
keys are rejected with a file:line error.

## Custom templates

`--template <name-or-path>` resolves the first match from:

1. A file path, if the argument contains `/` or ends in `.yaml`, `.yml`, or `.json` (relative to the current directory).
2. Project templates: `<app-root>/.decisions/templates/<name>.{yaml,yml,json}` (commit these with the app).
3. User templates: each directory in `$DTREE_TEMPLATES_PATH` (separated like `PATH`), then
   `${XDG_CONFIG_HOME:-~/.config}/decision-tree/templates/`.
4. Built-in templates in this directory.

To customize a built-in, copy it into `.decisions/templates/` (or a user directory) under the same
name; the earlier location wins. Keep templates generic: seed questions and prompts, and only
pre-fill options that apply to every tree created from the template.

To turn an existing tree into a project template, click "Save as template" on its overview in
`dtree serve`, or run `dtree template export <tree> -o x.yaml` then `dtree create-mode <name> --yaml x.yaml`.
