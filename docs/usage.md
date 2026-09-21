# Using AGR

## Guide generation

Run **AGR: Install Agent Skills**, then ask Claude Code or Codex to use the `agr` skill. The agent must write and validate `<git-root>/.agr/<name>.json`. A plan in chat or a Markdown file in a scratchpad is not the deliverable.

Examples:

> Use agr to review this PR: https://github.com/OWNER/REPO/pull/123. Start with the public contract, then behavior, then tests.

> Use agr to review the staged changes only. Keep unrelated unstaged work outside the guide.

> Use agr to review my branch against main and include my local follow-up changes as a separate comparison.

> Use agr to choose a sensible review scope for the feature we just built. Explain what you included and excluded.

The agent can organize steps around concerns instead of file names. Each step includes an explanation, an optional review question, and references to changed hunks. It can select smaller ranges when different concerns share a hunk. Agents should leave review status pending; the human marks approval.

## Review and navigation

Click a sidebar step to open a native diff. Some steps reference multiple files. Notes start collapsed, with comment icons on the relevant lines. Click a comment icon to open the explanation. Check the step when finished; progress is stored in the guide. **Next Step** and **Previous Step** follow the guide's order.

Use **AGR: Switch Review** to choose among `.agr/*.json` files. The picker shows scope, progress, and stale or unavailable status. Selection is remembered per repository. Use **AGR: Open Guide File** to inspect or edit the JSON. Changing a step's explanation invalidates its previous review. Use **AGR: Select Repository** when several Git roots are open.

## Optional GitHub Viewed sync

For a guide covering one complete PR comparison, run **AGR: Connect GitHub PR** and enter its `https://github.com/OWNER/REPO/pull/NUMBER` URL. Install GitHub CLI and run `gh auth login` first. AGR uses that account to update GitHub's **Viewed** checkboxes. Connecting is optional and remembered for this review in VS Code workspace storage, outside the shared guide.

AGR checks the current PR head and merge base against the guide's pinned commits. A file is marked Viewed only when every changed range on both sides is covered and every associated step, including optional steps, has a current reviewed fingerprint. Renames require both the old and new paths to be covered. Unchecking a step clears Viewed on its affected files. Connecting an existing guide marks complete files but does not clear other Viewed flags.

Progress saves locally first. GitHub requests run in the background, with status in the status bar. A failed request offers **Retry** and leaves local progress intact. **AGR: Disconnect GitHub PR** stops future sync without changing existing GitHub flags. A request already sent may still finish. GitHub status is not imported into AGR, and no approval, review comment, or PR submission is created.

The first version supports github.com PRs with one pinned revisions comparison and no path filters. Mixed scopes, branch-only reviews, staged edits, and unstaged edits stay local unless explicitly connected to a matching PR comparison. Changed PR commits or merge bases require an updated guide and reconnection. AGR checks the remote immediately before each update, but GitHub's Viewed mutation offers no atomic commit precondition. AGR does not fetch commits or poll the PR. Retry actions are available during the current VS Code session; reconnect to reconcile fully reviewed files after restarting.

## Skill installation location

**AGR: Install Agent Skills** asks whether to install **Globally** or in **This repository**. Global installation works without an open project and writes to `~/.agents/skills/agr/` for Codex and `~/.claude/skills/agr/` for Claude Code. If `CLAUDE_CONFIG_DIR` is set in VS Code’s environment, its directory replaces `~/.claude`. Repository installation writes both skill folders under the selected Git root. Canceling the prompt writes nothing.

Existing skills are not overwritten. Preserve customizations and move existing copies aside before reinstalling. Older repository skills may take precedence over a global installation, so update or remove those copies when switching to global skills. Review files always stay in each project’s `.agr/` folder. Start a fresh agent session after installing.

## Updating skills

The install command intentionally skips existing skill directories. To upgrade, preserve any local customizations, replace `.claude/skills/agr/` and `.agents/skills/agr/` with the release's `skills/agr/` folder, then start a fresh agent session. Alternatively, move the old directories outside the skill discovery folders and run the install command again. Avoid leaving old copies discoverable under another folder name.

Keep `SKILL.md`, `scopes.md`, `guide.schema.json`, and `scripts/agr.cjs` together. The helper is bundled and needs no `npm install` in the target repository.

## Validate a saved guide

From the target repository, after installing the Claude skill:

```sh
node .claude/skills/agr/scripts/agr.cjs validate . checkout-flow.json
```

Omit the filename to validate all reviews; any invalid, unavailable, or stale guide makes validation fail. For the Codex installation, substitute `.agents` for `.claude`. Validation follows the guide's declared scope and reports missing hunks, uncovered changes, invalid ranges, and baseline mismatches. See [scope recipes](../skills/agr/scopes.md) for explicit PR, branch, and mixed comparisons.

## Local artifacts

Store guides directly in `.agr/`, with descriptive filenames such as `checkout-flow.json`. Progress is saved in each guide. Snapshots and recipes belong in `.agr/.cache/`; snapshot exports use the selected review’s name. Only top-level JSON files are offered as reviews.

The entire `.agr/` folder is excluded from its own review, including tracked files. AGR does not add ignore rules. Add `.agr/` to `.git/info/exclude` or `.gitignore` if you want to keep reviews local.

Version 1.1 does not read root `agr.json`. Move an existing guide into `.agr/<name>.json` and update the installed skills. Move old snapshot and scope files into `.agr/.cache/` as well. The guide’s JSON structure and saved approvals are unchanged; the normal freshness checks still apply.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No guide appears | Confirm `.agr/<name>.json` is in the selected Git root. Run **AGR: Refresh**. |
| Agent only writes a chat message or scratchpad file | Update the skill and ask it to write and validate the actual `.agr/<name>.json` in the Git root. |
| Agent cannot find the skill | Confirm installation and start a fresh agent session. |
| A step is stale | Its changes, notes, ranges, or baseline no longer match. Regenerate the guide. |
| Unguided changes appear | Changes inside the chosen scope remain uncovered. Ask the agent to include them or explain a narrower scope. |
| PR content seems old | PR comparisons pin commits. Fetch updated objects and regenerate through the agent. |
| Local edits do not appear | Save the file, check the declared scope, refresh, and reopen the step. |
| Local snapshot fails | Resolve Git conflicts; check the error for missing Git objects, file-size limits, or unavailable Git. |
| A skill upgrade seems ignored | Preserve customizations and replace existing skill directories; installation does not overwrite them. |

See [review behavior and limitations](review-model.md) for exact scope and approval semantics.
