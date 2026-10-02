# decision-tree

Question-driven decision trees for planning software features. Agents build a tree of
**why / what / how / where** questions, enumerate options with pros and cons, and record the
chosen path with its rationale. Humans review, comment, and steer the same tree in a browser.

- **Storage:** each application keeps its own `.decisions/` folder, with one JSON file per feature tree.
- **Agent CLI:** `dtree.py` (a single Python 3 file using only the standard library; nothing to install).
- **Human viewer:** `dtree.py serve` opens a local web app that lists every tree, with graph, outline,
  and activity views, threaded comments, status editing, and "waiting on human / waiting on agent" queues.
- **Snapshots:** `dtree.py render -o tree.html` writes a self-contained, read-only HTML file.

## Layout

```
.devin-plugin/plugin.json             plugin manifest
skills/decision-tree/SKILL.md         agent instructions (workflow + command reference)
skills/decision-tree/scripts/dtree.py CLI, JSON store, HTTP API server
skills/decision-tree/scripts/viewer.html  single-file viewer (no external dependencies)
```

## Quick start

```bash
DT=skills/decision-tree/scripts/dtree.py
cd /path/to/your-app
python3 $DT init                                   # creates .decisions/ and vendors the tool into .decisions/_tool/
python3 $DT new "Add SSO login" -d "Enterprise customers need SSO"
python3 $DT add add-sso-login -p g1 -t question -k why --title "Why do we need SSO now?"
python3 $DT add add-sso-login -p q2 -t option --title "OIDC" --pro "Modern, simple" --con "Some IdPs SAML-only"
python3 $DT choose add-sso-login o3 -r "Covers 90% of customers"
python3 $DT review add-sso-login                   # gaps: unanswered questions, single-option questions, ...
python3 $DT inbox --for agent                      # human comments awaiting an agent reply
python3 $DT serve --port 8765 --scan ~/code        # browse all trees across apps
```

See [`skills/decision-tree/SKILL.md`](skills/decision-tree/SKILL.md) for the full workflow and command reference.

## Install as a skill

- **Devin:** install this repo as a plugin (it contains `.devin-plugin/plugin.json`).
- **Other agents:** copy `skills/decision-tree/` into the agent's skills directory.

Requires Python 3.8+.
