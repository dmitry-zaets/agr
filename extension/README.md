# AGR — Agent-Guided Reviews

**Turn a list of changed files into a review you can follow.**

AGR opens agent-authored review steps in VS Code's native diff editor, with short notes and saved progress. Review a feature in a meaningful order, and revisit different parts of the same file in separate sections.

Your Claude Code or Codex agent creates `.agr/<name>.json` in the Git repository root. Use **AGR: Switch Review** to choose a walkthrough; progress is saved independently for each review.

## Start a review

1. Open a trusted local Git repository in VS Code.
2. Run **AGR: Install Agent Skills in Repository** from the Command Palette.
3. Ask Claude Code or Codex:

   > Use the agr skill to create a guided review of my uncommitted changes. Split different concerns into separate steps and keep the review notes short.

4. Open **AGR** in the activity bar and click a step to see its diff and notes.
5. Mark the step reviewed using its checkbox or check action. Use the sidebar arrows for previous and next steps.

The skill is installed in `.claude/skills/agr/` and `.agents/skills/agr/`. Start a fresh agent session if necessary. Existing skills are not overwritten. The helper requires Node.js 22+ and Git; the extension requires VS Code 1.95+.

## Review the scope you need

- **Uncommitted:** staged and unstaged edits together, compared with HEAD.
- **Staged:** exactly what is in the Git index.
- **Unstaged:** saved working files compared with the index.
- **PR or branch:** merge-base compared with the feature tip.
- **Commit range:** an explicit base and head.
- **Mixed:** several comparisons, with optional file or directory limits.

Give your agent a PR link, branch name, or description of what you want reviewed. The agent records the chosen scope in the guide. For remote reviews, it fetches the Git objects using its existing tooling; AGR reads them locally without checking out another branch.

## Progress that follows the changes

A file can appear in multiple steps, each focused on a specific range. Your notes and review progress are saved in `.agr/<name>.json`. Changed code, notes, or comparison baselines can require another review. Uncovered changes within the guide's scope appear under **Unguided changes**.

PR and branch reviews pin their commits. Ask the agent to regenerate the guide after remote updates. Default local comparisons follow HEAD. Diffs show saved snapshots; reopen a step to see newer saved edits. Unsaved buffers are excluded. Binary changes are listed for inspection in another viewer.

## Commands

Search for **AGR** in the Command Palette to install skills, export a change snapshot, refresh the guide, open its JSON file, navigate steps, switch reviews, or select a repository in a multi-root workspace.

## Privacy and local files

AGR makes no network requests, collects no telemetry, and requires no model API key. Your chosen agent handles generation under its own settings and credentials. AGR writes guide progress and, when requested, skill files or an exported snapshot. It does not stage or commit changes.

Guide artifacts are excluded from their own review, but remain ordinary files in Git. Add `.agr/` to your Git ignore configuration if you want to keep them local.

## Version 1.1 layout

Use named files such as `.agr/checkout-flow.json` and `.agr/pr-142.json`. The picker shows scope, progress, and stale or unavailable status. Root `agr.json` is no longer read: move existing guides into `.agr/` and update the agent skill.

Local reviews can become stale after edits or commits. Their notes remain accessible, but old local file contents are not archived. Pinned reviews remain usable while their Git objects are available; fetch missing commits when needed.

## Help

If no review appears, check that the guide is saved directly inside `.agr/` in the selected Git repository root. Use **AGR: Refresh** after generating it. For stale steps, regenerate the guide against the latest changes.

[Usage and troubleshooting](https://github.com/dmitry-zaets/agr/blob/main/docs/usage.md) · [Source and issues](https://github.com/dmitry-zaets/agr) · [MIT license](https://github.com/dmitry-zaets/agr/blob/main/LICENSE)
