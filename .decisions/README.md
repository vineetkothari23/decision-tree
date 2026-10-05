# Decisions

Each `*.json` file here is a decision tree for one feature, created with the
`decision-tree` skill (`dtree`). Nodes are goals, questions (why/what/how/where...),
options, decisions, tasks and notes, each with a status and a comment thread.

View, comment and coordinate in a browser (run from the app root, needs Node >= 18):

    node .decisions/_tool/dtree.cjs serve        # http://127.0.0.1:8765
    npx @vineetkothari23/decision-tree serve             # same, without the vendored copy

Agents: `node .decisions/_tool/dtree.cjs --help`.
