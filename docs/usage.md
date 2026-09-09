# Using AGR

## Guide generation

Run **AGR: Install Agent Skills in Repository**, then ask Claude Code or Codex to use the `agr` skill. The agent must write and validate `<git-root>/agr.json`. A plan in chat or a Markdown file in a scratchpad is not the deliverable.

Examples:

> Use agr to review this PR: https://github.com/OWNER/REPO/pull/123. Start with the public contract, then behavior, then tests.

> Use agr to review the staged changes only. Keep unrelated unstaged work outside the guide.

> Use agr to review my branch against main and include my local follow-up changes as a separate comparison.

> Use agr to choose a sensible review scope for the feature we just built. Explain what you included and excluded.

The agent can organize steps around concerns instead of file names. Each step includes an explanation, an optional review question, and references to changed hunks. It can select smaller ranges when different concerns share a hunk. Agents should leave review status pending; the human marks approval.

## Review and navigation

Click a sidebar step to open a native diff. Some steps reference multiple files. Notes appear as native comments, with markers on the relevant ranges. Check the step when finished; progress is stored in the guide. **Next Step** and **Previous Step** follow the guide's order.

Use **AGR: Open Guide File** to inspect or edit the JSON. Changing a step's explanation invalidates its previous review. Use **AGR: Select Repository** when several Git roots are open.

## Updating skills

The install command intentionally skips existing skill directories. To upgrade, preserve any local customizations, replace `.claude/skills/agr/` and `.agents/skills/agr/` with the release's `skills/agr/` folder, then start a fresh agent session. Alternatively, move the old directories outside the skill discovery folders and run the install command again. Avoid leaving old copies discoverable under another folder name.

Keep `SKILL.md`, `scopes.md`, `guide.schema.json`, and `scripts/agr.cjs` together. The helper is bundled and needs no `npm install` in the target repository.

## Validate a saved guide

From the target repository, after installing the Claude skill:

```sh
node .claude/skills/agr/scripts/agr.cjs validate .
```

For the Codex installation, substitute `.agents` for `.claude`. Validation follows the guide's declared scope and reports missing hunks, uncovered changes, invalid ranges, and baseline mismatches. See [scope recipes](../skills/agr/scopes.md) for explicit PR, branch, and mixed comparisons.

## Local artifacts

`agr.json` contains the notes and review progress. `agr.snapshot.json` is an optional exported snapshot; `agr.scope.json` is an optional scope recipe. These files are excluded from their own review, but AGR does not add Git ignore rules. If you want them kept local, add their names to `.git/info/exclude` or an appropriate `.gitignore`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No guide appears | Confirm `agr.json` is in the selected Git root. Run **AGR: Refresh**. |
| Agent only writes a chat message or scratchpad file | Update the skill and ask it to write and validate the actual `agr.json` in the Git root. |
| Agent cannot find the skill | Confirm installation and start a fresh agent session. |
| A step is stale | Its changes, notes, ranges, or baseline no longer match. Regenerate the guide. |
| Unguided changes appear | Changes inside the chosen scope remain uncovered. Ask the agent to include them or explain a narrower scope. |
| PR content seems old | PR comparisons pin commits. Fetch updated objects and regenerate through the agent. |
| Local edits do not appear | Save the file, check the declared scope, refresh, and reopen the step. |
| Local snapshot fails | Resolve Git conflicts; check the error for missing Git objects, file-size limits, or unavailable Git. |
| A skill upgrade seems ignored | Preserve customizations and replace existing skill directories; installation does not overwrite them. |

See [review behavior and limitations](review-model.md) for exact scope and approval semantics.
