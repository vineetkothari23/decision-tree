"use strict";

/** The commented example template written by `dtree init --templates`. */

const EXAMPLE_TEMPLATE = `# Example custom decision-tree template ("mode").
#
# Copy this file to <name>.yaml, set \`name:\` to the same <name>, and edit the nodes:
#   .decisions/templates/<name>.yaml               project templates (commit them with the app)
#   ~/.config/decision-tree/templates/<name>.yaml  user templates (or a dir in $DTREE_TEMPLATES_PATH)
# Or register any file:  dtree create-mode <name> --yaml ./my-template.yaml [--user]
# Then:                  dtree new "<title>" --template <name>      (list them: dtree templates)
#
# Supported YAML: comments, key: value mappings, "- " lists, quoted strings, [a, b] lists,
# and | / > multi-line text. Anchors, aliases, tags and flow mappings are rejected.
template: 1                      # format version (required)
name: example                    # must match the file name (required)
title: Example custom template   # shown in \`dtree templates\` (required)
description: |                   # optional; the tree description when \`dtree new\` has no -d
  Replace these nodes with the questions your team always asks.
tree_status: draft               # optional: draft|active|decided|implemented|archived
nodes:                           # added under the root goal, in this order (required)
  - title: Why are we doing this, and why now?
    kind: why                    # questions: why|what|how|where|who|when|risk|other
    body: |
      What problem, for whom, and what evidence do we have?
  - title: What is in and out of scope?
    kind: what
  - title: How should we build it?
    kind: how
    children:                    # nest to any depth
      - title: Simplest thing that could work
        type: option             # question|option|decision|task|note (never goal)
        pros: [Fast to ship]
        cons: [May not scale]
  - title: Write the rollout checklist
    type: task
    assignee: agent
`;

module.exports = { EXAMPLE_TEMPLATE };
