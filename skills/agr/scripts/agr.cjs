#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// packages/core/src/model.ts
function parseScope(value) {
  const scope = value;
  if (!scope || !Array.isArray(scope.comparisons) || !scope.comparisons.length) throw new Error("Scope needs at least one comparison.");
  const ids = /* @__PURE__ */ new Set();
  for (const c of scope.comparisons) {
    if (!c || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(c.id) || ids.has(c.id)) throw new Error("Comparison IDs must be unique letters, numbers, underscores, or hyphens.");
    ids.add(c.id);
    if (!["working-tree", "staged", "unstaged", "revisions"].includes(c.kind)) throw new Error(`Unknown comparison kind: ${c.kind}`);
    if (c.title !== void 0 && typeof c.title !== "string") throw new Error("Comparison title must be text.");
    if (c.base !== void 0 && c.base !== null && (typeof c.base !== "string" || !c.base.trim())) throw new Error("Invalid base revision.");
    if (c.head !== void 0 && (typeof c.head !== "string" || !c.head.trim())) throw new Error("Invalid head revision.");
    if (c.kind === "revisions" && (!c.base || !c.head)) throw new Error("A revisions comparison needs base and head commits.");
    if (c.kind !== "revisions" && c.head !== void 0) throw new Error("Only revisions comparisons accept head.");
    if (c.kind === "unstaged" && c.base !== void 0) throw new Error("Unstaged comparisons always start from the index.");
    if (c.baseRef !== void 0 && (c.baseRef !== "HEAD" || !["working-tree", "staged"].includes(c.kind))) throw new Error("baseRef is supported only for local comparisons following HEAD.");
    if (c.includeUntracked !== void 0 && typeof c.includeUntracked !== "boolean") throw new Error("includeUntracked must be boolean.");
    if (c.includeUntracked && !["working-tree", "unstaged"].includes(c.kind)) throw new Error("Only working-tree and unstaged comparisons can include untracked files.");
    if (c.paths !== void 0 && (!Array.isArray(c.paths) || !c.paths.length || c.paths.some((p) => typeof p !== "string" || !p || p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.split("/").includes("..") || /[*?\[\]]/.test(p)))) throw new Error("paths must contain literal repository-relative files or directories, without traversal or glob patterns.");
  }
  return scope;
}
function parseGuide(text) {
  const g = JSON.parse(text);
  const fail = (message) => {
    throw new Error(`Invalid review guide: ${message}`);
  };
  const string = (value) => typeof value === "string" && value.trim().length > 0;
  if (!g || g.version !== 1 || !string(g.title) || !["head-to-working-tree", "scoped"].includes(g.comparison)) {
    fail("expected version 1, title, and a supported comparison.");
  }
  if (g.comparison === "scoped") parseScope(g.scope);
  else if (g.scope !== void 0) fail('scope requires comparison "scoped".');
  if (g.base !== null && (typeof g.base !== "string" || !/^[a-f0-9]{40,64}$/.test(g.base))) fail("base must be a commit hash or null.");
  if (g.summary !== void 0 && typeof g.summary !== "string") fail("summary must be text.");
  if (!Array.isArray(g.groups)) fail("groups must be an array.");
  const ids = /* @__PURE__ */ new Set();
  for (const group of g.groups) {
    if (!group || !string(group.id) || !string(group.title) || !Array.isArray(group.steps)) fail("each group needs id, title, and steps.");
    if (ids.has(group.id)) fail(`duplicate id ${group.id}.`);
    ids.add(group.id);
    for (const step of group.steps) {
      if (!step || !string(step.id) || !string(step.title) || typeof step.note !== "string") fail("each step needs id, title, and note.");
      if (ids.has(step.id)) fail(`duplicate id ${step.id}.`);
      ids.add(step.id);
      if (!Array.isArray(step.changes) || !step.changes.length || !step.changes.every((c) => typeof c === "string" && /^c_[a-f0-9]{64}$/.test(c))) fail(`${step.id}: changes must contain snapshot change IDs.`);
      if (new Set(step.changes).size !== step.changes.length) fail(`${step.id}: duplicate changes.`);
      if (step.selections !== void 0) {
        if (!step.selections || typeof step.selections !== "object" || Array.isArray(step.selections)) fail(`${step.id}: invalid selections.`);
        for (const [id, selection] of Object.entries(step.selections)) {
          if (!step.changes.includes(id) || !selection || typeof selection !== "object" || !selection.original && !selection.modified) fail(`${step.id}: selection must reference a change and at least one side.`);
          for (const range of [selection.original, selection.modified]) {
            if (range !== void 0 && (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start)) fail(`${step.id}: selection offsets must be positive, inclusive ranges.`);
          }
        }
      }
      if (step.focus !== void 0 && typeof step.focus !== "string") fail(`${step.id}: focus must be text.`);
      if (step.optional !== void 0 && typeof step.optional !== "boolean") fail(`${step.id}: optional must be boolean.`);
      if (step.review !== void 0 && (!step.review || !["pending", "reviewed"].includes(step.review.status))) fail(`${step.id}: invalid review status.`);
      if (step.review?.fingerprint !== void 0 && typeof step.review.fingerprint !== "string") fail(`${step.id}: invalid fingerprint.`);
    }
  }
  return g;
}
function selectedChanges(step, snapshot) {
  return step.changes.flatMap((id) => {
    const change = snapshot.changes.find((c) => c.id === id);
    if (!change) return [];
    const selection = step.selections?.[id];
    if (!selection) return [change];
    const { original, modified } = selection;
    if (change.kind !== "text" || original && original.end > change.oldLines || modified && modified.end > change.newLines) return [];
    return [{
      ...change,
      oldStart: original ? change.oldStart + original.start - 1 : change.oldStart,
      oldLines: original ? original.end - original.start + 1 : 0,
      newStart: modified ? change.newStart + modified.start - 1 : change.newStart,
      newLines: modified ? modified.end - modified.start + 1 : 0
    }];
  });
}
function uncoveredChanges(guide, snapshot) {
  const selected = guide?.base === snapshot.base ? allSteps(guide).flatMap((s) => selectedChanges(s, snapshot)) : [];
  return snapshot.changes.flatMap((change) => {
    const coverage = selected.filter((c) => c.id === change.id);
    if (!coverage.length) return [change];
    if (change.kind !== "text") return [];
    const missing = [];
    for (const side of ["old", "new"]) {
      const startKey = `${side}Start`;
      const linesKey = `${side}Lines`;
      let run = -1;
      for (let index = 0; index <= change[linesKey]; index++) {
        const line = change[startKey] + index;
        const uncovered = index < change[linesKey] && !coverage.some((c) => line >= c[startKey] && line < c[startKey] + c[linesKey]);
        if (uncovered && run < 0) run = index;
        if (!uncovered && run >= 0) {
          missing.push({ ...change, oldLines: 0, newLines: 0, [startKey]: change[startKey] + run, [linesKey]: index - run });
          run = -1;
        }
      }
    }
    return missing;
  });
}
function validateCoverage(guide, snapshot) {
  const current = new Set(snapshot.changes.map((c) => c.id));
  return {
    missing: uncoveredChanges(guide, snapshot).map((c) => c.id),
    unknown: [...new Set(allSteps(guide).flatMap((s) => s.changes).filter((id) => !current.has(id)))],
    invalidSelections: allSteps(guide).filter((step) => step.changes.every((id) => current.has(id)) && selectedChanges(step, snapshot).length !== step.changes.length).map((step) => step.id),
    baseMatches: guide.base === snapshot.base
  };
}
var import_node_crypto, hash, allSteps;
var init_model = __esm({
  "packages/core/src/model.ts"() {
    "use strict";
    import_node_crypto = require("node:crypto");
    hash = (value) => (0, import_node_crypto.createHash)("sha256").update(value).digest("hex");
    allSteps = (guide) => guide.groups.flatMap((g) => g.steps);
  }
});

// packages/core/src/git.ts
var git_exports = {};
__export(git_exports, {
  baseContent: () => baseContent,
  git: () => git,
  head: () => head,
  identifyChanges: () => identifyChanges,
  parseHunks: () => parseHunks,
  repositoryRoot: () => repositoryRoot,
  safePath: () => safePath,
  snapshotRepository: () => snapshotRepository,
  workingContent: () => workingContent
});
async function git(root, args) {
  const { stdout } = await exec("git", ["--no-pager", ...args], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 3e4,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }
  });
  return stdout;
}
async function repositoryRoot(cwd) {
  const canonical = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const relative = (await git(cwd, ["rev-parse", "--show-cdup"])).trim();
  const logical = import_node_path.default.resolve(cwd, relative);
  return await (0, import_promises.realpath)(logical) === await (0, import_promises.realpath)(canonical) ? logical : canonical;
}
async function head(root) {
  try {
    return (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    await git(root, ["rev-parse", "--git-dir"]);
    return null;
  }
}
async function safePath(root, file) {
  if (!file || import_node_path.default.isAbsolute(file) || file.split(/[\\/]/).includes("..") || file.includes("\0")) throw new Error("Unsafe repository path.");
  const absolute = import_node_path.default.resolve(root, file);
  let parent = import_node_path.default.dirname(absolute);
  while (true) {
    try {
      const actual = await (0, import_promises.realpath)(parent);
      const canonical = await (0, import_promises.realpath)(root);
      if (actual !== canonical && !actual.startsWith(canonical + import_node_path.default.sep)) throw new Error("Path leaves the repository.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      parent = import_node_path.default.dirname(parent);
    }
  }
  return absolute;
}
async function workingContent(root, file) {
  const absolute = await safePath(root, file);
  try {
    const stat = await (0, import_promises.lstat)(absolute);
    if (stat.isSymbolicLink()) return Buffer.from(await (0, import_promises.readlink)(absolute));
    if (!stat.isFile()) return Buffer.from("[Directory or submodule]");
    if (stat.size > 8 * 1024 * 1024) throw new Error(`${file} exceeds the 8 MB per-file limit.`);
    return await (0, import_promises.readFile)(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}
async function baseContent(root, base, file) {
  await safePath(root, file);
  if (!base) return "";
  try {
    return await git(root, ["show", `${base}:${file}`]);
  } catch (error) {
    const exists = await git(root, ["ls-tree", "-z", base, "--", file]);
    if (!exists) return "";
    throw error;
  }
}
function parseHunks(file, patch) {
  const lines = patch.split("\n");
  const result = [];
  let current;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = {
        file,
        kind: "text",
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        patch: ""
      };
      result.push(current);
    } else if (current && /^[+\-\\ ]/.test(line)) current.patch += line + "\n";
  }
  return result;
}
function identifyChanges(changes) {
  const keys = changes.map((c) => hash(JSON.stringify([c.file, c.kind, c.patch])));
  const counts = /* @__PURE__ */ new Map();
  keys.forEach((key) => counts.set(key, (counts.get(key) ?? 0) + 1));
  return changes.map((c, i) => ({
    ...c,
    // Identical patches in one file are ambiguous. Include locations, conservatively
    // invalidating them on shifts rather than attaching approval to the wrong change.
    id: "c_" + hash(JSON.stringify([keys[i], counts.get(keys[i]) === 1 ? null : [c.oldStart, c.newStart]]))
  }));
}
async function snapshotRepository(cwd, selectedFiles) {
  const root = await repositoryRoot(cwd);
  const base = await head(root);
  const tracked = await git(root, base ? ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--"] : ["ls-files", "-z"]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const unmerged = await git(root, ["ls-files", "--unmerged", "-z"]);
  if (unmerged) throw new Error("Resolve merge conflicts before generating a review guide.");
  const files = [...new Set((tracked + untracked).split("\0").filter(Boolean))].filter((f) => !["agr.json", "agr.snapshot.json", "agr.scope.json"].includes(f)).filter((f) => !selectedFiles || selectedFiles.includes(f)).sort();
  const changes = [];
  for (const file of files) {
    const bytes = await workingContent(root, file);
    const entry = base ? await git(root, ["ls-tree", "-z", base, "--", file]) : "";
    if (!entry) {
      const stat = await (0, import_promises.lstat)(await safePath(root, file));
      const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 73 ? "100755" : "100644";
      const binary = bytes.includes(0);
      const content = bytes.toString("utf8");
      const lines = content ? content.split("\n") : [];
      if (content.endsWith("\n")) lines.pop();
      const patch2 = lines.map((line) => "+" + line + "\n").join("") + (content && !content.endsWith("\n") ? "\\ No newline at end of file\n" : "");
      changes.push({
        file,
        kind: binary ? "binary" : content ? "text" : "metadata",
        oldStart: 0,
        oldLines: 0,
        newStart: content && !binary ? 1 : 0,
        newLines: binary ? 0 : lines.length,
        patch: binary ? `new file mode ${mode}
content-sha256:${hash(bytes.toString("base64"))}` : `new file mode ${mode}
${patch2}`
      });
      continue;
    }
    const patch = base ? await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=0", base, "--", file]) : "";
    const hunks = parseHunks(file, patch);
    if (hunks.length) {
      changes.push(...hunks);
      if (/^(old mode|new mode) /m.test(patch)) changes.push({ file, kind: "metadata", oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, patch: patch.split("\n").filter((l) => /^(old mode|new mode) /.test(l)).join("\n") });
    } else if (patch || bytes.length || !base || untracked.split("\0").includes(file)) {
      const isNew = !patch;
      const binary = bytes.includes(0) || /^Binary files /m.test(patch);
      const text = bytes.toString("utf8");
      const lineCount = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      changes.push({
        file,
        kind: binary ? "binary" : isNew && bytes.length ? "text" : "metadata",
        oldStart: 0,
        oldLines: 0,
        newStart: lineCount ? 1 : 0,
        newLines: binary ? 0 : lineCount,
        patch: binary ? `${patch}
content-sha256:${hash(bytes.toString("base64"))}` : isNew ? text.split("\n").map((l) => "+" + l).join("\n") : patch
      });
    }
  }
  if (await head(root) !== base) throw new Error("HEAD changed during the scan. Refresh and try again.");
  return { version: 1, root, base, comparison: "head-to-working-tree", changes: identifyChanges(changes) };
}
var import_node_child_process, import_node_util, import_promises, import_node_path, exec;
var init_git = __esm({
  "packages/core/src/git.ts"() {
    "use strict";
    import_node_child_process = require("node:child_process");
    import_node_util = require("node:util");
    import_promises = require("node:fs/promises");
    import_node_path = __toESM(require("node:path"));
    init_model();
    exec = (0, import_node_util.promisify)(import_node_child_process.execFile);
  }
});

// packages/core/src/cli.ts
var import_promises3 = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"));
init_git();
init_model();

// packages/core/src/scope.ts
var import_node_child_process2 = require("node:child_process");
var import_node_util2 = require("node:util");
var import_promises2 = require("node:fs/promises");
init_model();
init_git();
var exec2 = (0, import_node_util2.promisify)(import_node_child_process2.execFile);
var diffFlags = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];
var artifacts = /* @__PURE__ */ new Set(["agr.json", "agr.snapshot.json", "agr.scope.json"]);
async function revision(root, ref) {
  return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}
async function resolveScope(root, scope) {
  const comparisons = [];
  for (const c of parseScope(scope).comparisons) {
    const next = { id: c.id, kind: c.kind };
    if (c.title !== void 0) next.title = c.title;
    if (c.kind !== "unstaged") {
      const followsHead = ["working-tree", "staged"].includes(c.kind) && (c.baseRef === "HEAD" || c.base === void 0 || c.base === "HEAD");
      next.base = followsHead ? await head(root) : c.base === null ? null : await revision(root, c.base);
      if (followsHead) next.baseRef = "HEAD";
    }
    if (c.kind === "revisions") next.head = await revision(root, c.head);
    if (["working-tree", "unstaged"].includes(c.kind)) next.includeUntracked = c.includeUntracked ?? true;
    if (c.paths) next.paths = [...new Set(c.paths.map((p) => p.replace(/\/$/, "")))].sort();
    comparisons.push(next);
  }
  return { comparisons };
}
function diffArgs(c) {
  if (c.kind === "revisions") return [c.base, c.head];
  if (c.kind === "staged") return ["--cached", ...c.base ? [c.base] : []];
  if (c.kind === "working-tree") return c.base ? [c.base] : [];
  return [];
}
async function indexContent(root, file) {
  const entry = await git(root, ["ls-files", "--stage", "-z", "--", file]);
  if (!entry) return Buffer.alloc(0);
  const match = /^(\d+) ([a-f0-9]+) 0\t/.exec(entry);
  if (!match) throw new Error(`Unmerged index entry: ${file}`);
  if (match[1] === "160000") return Buffer.from(`Subproject commit ${match[2]}
`);
  return objectContent(root, match[2]);
}
async function objectContent(root, object) {
  const result = await exec2("git", ["cat-file", "blob", object], { cwd: root, encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 3e4 });
  return result.stdout;
}
async function revisionContent(root, ref, file) {
  if (!ref) return Buffer.alloc(0);
  const entry = await git(root, ["ls-tree", "-z", ref, "--", file]);
  if (!entry) return Buffer.alloc(0);
  const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t/.exec(entry);
  if (!match) throw new Error(`Cannot review non-file entry: ${file}`);
  if (match[1] === "160000") return Buffer.from(`Subproject commit ${match[2]}
`);
  return objectContent(root, match[2]);
}
async function comparisonContent(root, c, file, side) {
  if (!file || file.startsWith("/") || file.split("/").includes("..") || file.includes("\0")) throw new Error("Unsafe comparison path.");
  if (side === "original") return c.kind === "unstaged" ? indexContent(root, file) : revisionContent(root, c.base, file);
  if (c.kind === "revisions") return revisionContent(root, c.head, file);
  if (c.kind === "staged") return indexContent(root, file);
  return workingContent(root, file);
}
async function snapshotScope(cwd, input, selectedFiles) {
  const root = await repositoryRoot(cwd);
  const scope = await resolveScope(root, input);
  const usesIndex = scope.comparisons.some((c) => c.kind !== "revisions");
  const indexBefore = usesIndex ? await git(root, ["ls-files", "--stage", "-z"]) : "";
  if (usesIndex && await git(root, ["ls-files", "--unmerged", "-z"])) throw new Error("Resolve merge conflicts before reviewing index or working-tree changes.");
  const changes = [];
  for (const c of scope.comparisons) {
    const emptyBase = ["working-tree", "staged"].includes(c.kind) && c.base === null;
    const names = await git(root, emptyBase ? ["ls-files", "-z"] : ["diff", ...diffFlags, ...diffArgs(c), "--name-only", "-z", "--"]);
    const untracked = c.includeUntracked ? (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean) : [];
    const files = [.../* @__PURE__ */ new Set([...names.split("\0").filter(Boolean), ...untracked])].filter((file) => !artifacts.has(file)).filter((file) => !selectedFiles || selectedFiles.includes(file)).filter((file) => !c.paths || c.paths.some((p) => p === "." || file === p || file.startsWith(p + "/"))).sort();
    const parts = [];
    for (const file of files) {
      const newWorkingFile = c.kind === "working-tree" && c.base && !await git(root, ["ls-tree", "-z", c.base, "--", file]);
      const syntheticAddition = emptyBase || untracked.includes(file) || newWorkingFile;
      let patch = "";
      const bytes = await comparisonContent(root, c, file, "modified");
      if (syntheticAddition) {
        let mode;
        if (c.kind === "staged") {
          mode = (await git(root, ["ls-files", "--stage", "-z", "--", file])).split(" ")[0];
        } else {
          let stat;
          try {
            stat = await (0, import_promises2.lstat)(await safePath(root, file));
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          mode = stat.isSymbolicLink() ? "120000" : stat.mode & 73 ? "100755" : "100644";
        }
        const text = bytes.toString("utf8");
        const lines = text ? text.split("\n") : [];
        if (text.endsWith("\n")) lines.pop();
        const binary = bytes.includes(0);
        parts.push({
          file,
          kind: binary ? "binary" : text ? "text" : "metadata",
          oldStart: 0,
          oldLines: 0,
          newStart: lines.length && !binary ? 1 : 0,
          newLines: binary ? 0 : lines.length,
          patch: `new file mode ${mode}
` + (binary ? `content-sha256:${hash(bytes.toString("base64"))}` : lines.map((line) => "+" + line + "\n").join("") + (text && !text.endsWith("\n") ? "\\ No newline at end of file\n" : ""))
        });
        continue;
      }
      patch = await git(root, ["diff", ...diffFlags, ...diffArgs(c), "--unified=0", "--", file]);
      if (!patch) continue;
      const hunks = parseHunks(file, patch);
      parts.push(...hunks);
      const modes = patch.split("\n").filter((line) => /^(old mode|new mode) /.test(line)).join("\n");
      if (hunks.length && modes) parts.push({ file, kind: "metadata", oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, patch: modes });
      if (!hunks.length) {
        const binary = bytes.includes(0) || /^Binary files /m.test(patch);
        parts.push({
          file,
          kind: binary ? "binary" : "metadata",
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          patch: patch + (binary ? `
content-sha256:${hash(bytes.toString("base64"))}` : "")
        });
      }
    }
    changes.push(...identifyChanges(parts).map((change) => ({ ...change, comparisonId: c.id, id: "c_" + hash(JSON.stringify([c.id, change.id])) })));
  }
  if (usesIndex && indexBefore !== await git(root, ["ls-files", "--stage", "-z"])) throw new Error("The index changed during the scan. Refresh and try again.");
  const base = hash(JSON.stringify(scope));
  return { version: 1, root, comparison: "scoped", scope, base, changes };
}
async function snapshotForGuide(root, guide, files) {
  return guide?.scope ? snapshotScope(root, guide.scope, files) : snapshotRepository(root, files);
}

// packages/core/src/cli.ts
async function main() {
  const args = process.argv.slice(2);
  const scopeFlag = args.indexOf("--scope");
  let scopeFile;
  if (scopeFlag >= 0) {
    scopeFile = args[scopeFlag + 1];
    if (!scopeFile) throw new Error("--scope requires a JSON file.");
    args.splice(scopeFlag, 2);
  }
  const [command, directory = ".", output] = args;
  if (!["snapshot", "validate"].includes(command)) throw new Error("Usage: node agr.cjs snapshot <repo> [output.json] | validate <repo> [guide.json]");
  if (command === "snapshot") {
    const snapshot = scopeFile ? await snapshotScope(import_node_path2.default.resolve(directory), JSON.parse(await (0, import_promises3.readFile)(import_node_path2.default.resolve(scopeFile), "utf8"))) : await snapshotRepository(import_node_path2.default.resolve(directory));
    const text = JSON.stringify(snapshot, null, 2) + "\n";
    if (output) await (0, import_promises3.writeFile)(import_node_path2.default.resolve(output), text, { flag: "w" });
    else process.stdout.write(text);
  } else {
    if (scopeFile) throw new Error("validate reads scope from the guide; do not pass --scope.");
    const { repositoryRoot: repositoryRoot2 } = await Promise.resolve().then(() => (init_git(), git_exports));
    const root = await repositoryRoot2(import_node_path2.default.resolve(directory));
    const guide = parseGuide(await (0, import_promises3.readFile)(output ? import_node_path2.default.resolve(output) : import_node_path2.default.join(root, "agr.json"), "utf8"));
    const snapshot = await snapshotForGuide(root, guide);
    const result = validateCoverage(guide, snapshot);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.baseMatches || result.missing.length || result.unknown.length || result.invalidSelections.length) process.exitCode = 1;
  }
}
main().catch((error) => {
  process.stderr.write(`${error.message}
`);
  process.exitCode = 1;
});
