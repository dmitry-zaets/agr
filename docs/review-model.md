# Review scopes and progress


The agent chooses and records an explicit scope from your request. Supported comparisons:

| Scope | Original → modified |
| --- | --- |
| Uncommitted | HEAD → saved working files, optionally including untracked files |
| Staged | HEAD → index |
| Unstaged | Index → saved working files, optionally including untracked files |
| Branch / PR | Merge-base with the target branch → feature/PR tip |
| Commit / range | Chosen parent or base commit → chosen head commit |
| Mixed | Several independent comparisons in one guide |

Each comparison may include literal file or directory limits. The agent explains exclusions in the guide summary. Coverage and Unguided changes refer to this declared scope, not unrelated changes outside it. The sidebar shows the scope, and diff tabs distinguish versions of the same file.

For a PR link, the skill instructs the agent to retrieve metadata, verify the local repository, fetch the relevant Git objects, and compute the merge-base. The extension reads these local objects without switching branches. It does not fetch Git objects. Optional GitHub Viewed sync authenticates through `gh` only after the user connects a PR; see [usage](usage.md#optional-github-viewed-sync). PR and branch guides pin commit hashes and do not poll remotes; ask the agent to regenerate after updates. Default staged/working comparisons continue following HEAD. Existing guides remain supported.

- Without an explicit scope, the comparison remains HEAD versus saved working files, combining staged and unstaged edits plus untracked files. Staging alone does not add a second version to that combined review. Unsaved buffers are excluded.
- A step refers to one or more content-addressed, zero-context Git diff hunks. Optional range selections split even a single hunk across steps, including different sections of a newly added file. Steps can span files; one file can appear repeatedly.
- Diffs use read-only snapshots. Reopen a step to see newer saved content. Highlighting marks the selected ranges on each side; notes appear as native comments. Pure deletions are annotated on the original side.
- Review fingerprints cover the comparison scope, selected hunks, ranges, and explanation. Changed or missing hunks, changed notes, and a changed local baseline require another look. Unique hunks retain identity across unrelated line shifts. Ambiguous duplicate hunks are treated conservatively. An edit anywhere in a subdivided hunk invalidates its slices; regeneration reconnects them.
- An edit can move a hunk out of the guide. Its old step remains visibly stale; the new hunk appears under **Unguided changes**. Regenerate the guide to reconnect it. Only the human marks steps reviewed.
- Coverage includes every changed hunk, including omitted parts of files already in the guide. Optional steps count as covered but remain explicitly optional. Renames are shown as delete/add. Mode changes remain visible.
- Binary changes are listed and tracked by fingerprint, with a prompt to inspect them in an appropriate viewer. They are not rendered as text. Merge conflicts block local working/index scans; committed comparisons remain independent of local conflicts. Oversized file reads and Git outputs produce explicit errors rather than silently disappearing.
- Use **Select Repository** for multi-root workspaces. Nested repositories and submodule internals should be opened as their own workspace folders.

The guide and snapshot are local artifacts excluded from their own review. To keep them out of your repository status, optionally add `.agr/` to your own Git ignore configuration. The extension does not change ignore files.

## Multiple reviews

Each `.agr/*.json` file has independent progress. Switching reviews clears the previous review’s comments and range markers. A stale local guide keeps its notes, but opening an outdated step requires regeneration. If pinned Git objects are missing, the review remains listed as unavailable; fetch the commits or open the guide to read its notes. AGR does not archive old local file contents.
