# Agent notes

- Plan new features with the `decision-tree` skill (linked from `.agents/skills/` and `.claude/skills/` to `skills/decision-tree/`). Trees live in `.decisions/`; commit them with the change they plan.
- In this repo, run the CLI from source so you plan with the code being developed: `node skills/decision-tree/scripts/dtree.cjs <command>` (use it as `$DTREE` in the skill's examples). `.decisions/_tool/` is git-ignored.
- Setup: `source ~/.nvm/nvm.sh && npm install`. Checks: `npm test`, `npm run lint`, `npm pack --dry-run`.
