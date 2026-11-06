/**
 * Working-tree snapshot: the exact code revision a hosted assessment looks at.
 * Includes uncommitted and untracked (non-ignored) files, excludes credentials and vendor dirs,
 * redacts secret-looking values, and records a content hash per file for stale/dismissal checks.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { deniedPathReason, redact } from "./secrets.ts";
import { nowIso, sha256 } from "./util.ts";

export interface RepoIdentity {
  repoId: string;
  name: string;
  remote: string | null;
  root: string;
}

export interface SnapshotManifest {
  included: Array<{ path: string; bytes: number; sha: string; redacted?: string[] }>;
  excluded: Array<{ path: string; reason: string }>;
  changedPaths: string[];
}

export interface Snapshot {
  id: string;
  repo: RepoIdentity;
  head: string | null;
  branch: string | null;
  dirty: boolean;
  revision: string;
  createdAt: string;
  manifest: SnapshotManifest;
  fileHashes: Record<string, string>;
  diffPatch: string;
  stageDir: string; // <stateDir>/snapshots/<id>  (contains repo/)
  bytes: number;
}

function git(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "ignore"] });
}

function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args).trim();
  } catch {
    return null;
  }
}

/** HEAD + `git status` + sizes/mtimes of changed files: changes when files change, without reading every file. */
export function worktreeFingerprint(root: string): string {
  const head = tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]) ?? "nohead";
  const paths = changedPaths(root).sort();
  const stats = paths.map((p) => {
    try {
      const st = fs.statSync(path.join(root, p));
      return `${p}:${st.size}:${st.mtimeMs}`;
    } catch {
      return `${p}:gone`;
    }
  });
  return sha256(`${head}\n${stats.join("\n")}`);
}

export function repoIdentity(root: string): RepoIdentity {
  const remote = tryGit(root, ["config", "--get", "remote.origin.url"]);
  // Strip credentials that sometimes live in remote URLs before hashing or storing.
  const safeRemote = remote ? remote.replace(/\/\/[^@/]+@/, "//") : null;
  const real = fs.realpathSync(root);
  return { repoId: `repo_${sha256(safeRemote || real).slice(0, 12)}`, name: path.basename(real), remote: safeRemote, root: real };
}

function listCandidateFiles(root: string, untracked: Set<string> | "all"): { files: string[]; skippedUntracked: string[] } {
  let tracked: string | null = null;
  let others = "";
  try {
    tracked = git(root, ["ls-files", "-z", "--cached"]);
    others = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  } catch {
    tracked = null;
  }
  if (tracked !== null) {
    const o = others.split("\0").filter(Boolean);
    const keep = untracked === "all" ? o : o.filter((p) => untracked.has(p));
    return { files: [...new Set([...tracked.split("\0").filter(Boolean), ...keep])], skippedUntracked: o.filter((p) => !keep.includes(p)) };
  }
  // Not a git repo: bounded walk.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      if (deniedPathReason(ent.isDirectory() ? `${rel}/` : rel)) continue;
      if (ent.isDirectory()) walk(rel);
      else if (ent.isFile()) files.push(rel);
      if (files.length > 20_000) return;
    }
  };
  walk("");
  return { files, skippedUntracked: [] };
}

function changedPaths(root: string): string[] {
  let out: string;
  try {
    out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]); // no trim: entries start with a status column that may be a space
  } catch {
    return [];
  }
  const parts = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.startsWith("R") || xy.startsWith("C")) i++; // rename/copy: next part is the source path
  }
  return [...new Set(paths)];
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/**
 * untracked: "all", or only the untracked files that are part of the work being reviewed (edited in the batch).
 * Untracked files nobody touched are often personal notes or scratch files: they are listed, never included.
 */
export function buildSnapshot(cfg: Config, keepIds: string[] = [], baseHead: string | null = null, untrackedPolicy: Set<string> | "all" = "all"): Snapshot {
  const root = cfg.repoRoot;
  const repo = repoIdentity(root);
  const head = tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const branch = head ? tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
  // Work committed during the batch (HEAD moved since its first event) is part of what gets reviewed.
  const base = baseHead && head && baseHead !== head && /^[0-9a-f]{40}$/.test(baseHead) && tryGit(root, ["cat-file", "-e", `${baseHead}^{commit}`]) !== null ? baseHead : head;
  const committed = base && base !== head ? (tryGit(root, ["diff", "--name-only", "-z", base, "HEAD"]) ?? "").split("\0").filter(Boolean) : [];
  const worktreeChanged = changedPaths(root);
  const changed = [...new Set([...worktreeChanged, ...committed])];
  const changedSet = new Set(changed);

  const manifest: SnapshotManifest = { included: [], excluded: [], changedPaths: [] };
  type Cand = { rel: string; buf: Buffer };
  const cands: Cand[] = [];
  const listed = listCandidateFiles(root, untrackedPolicy);
  for (const rel of listed.skippedUntracked) if (!deniedPathReason(rel)) manifest.excluded.push({ path: rel, reason: "untracked and not part of this work" });
  for (const rel of listed.files) {
    const denied = deniedPathReason(rel);
    if (denied) {
      manifest.excluded.push({ path: rel, reason: denied });
      continue;
    }
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // deleted in working tree
    }
    if (!st.isFile()) continue; // symlinks and others are not followed
    if (st.size > cfg.maxFileBytes) {
      manifest.excluded.push({ path: rel, reason: `larger than ${cfg.maxFileBytes} bytes` });
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) {
      manifest.excluded.push({ path: rel, reason: "binary" });
      continue;
    }
    cands.push({ rel, buf });
  }
  // Changed files first, then small files, so the size cap drops large unchanged files first.
  cands.sort((a, b) => Number(changedSet.has(b.rel)) - Number(changedSet.has(a.rel)) || a.buf.length - b.buf.length);

  const fileHashes: Record<string, string> = {};
  const staged: Array<{ rel: string; text: string }> = [];
  let total = 0;
  for (const { rel, buf } of cands) {
    if (total + buf.length > cfg.maxSnapshotBytes) {
      manifest.excluded.push({ path: rel, reason: "snapshot size cap" });
      continue;
    }
    total += buf.length;
    const sha = sha256(buf);
    fileHashes[rel] = sha;
    const { text, hits } = redact(buf.toString("utf8"));
    manifest.included.push({ path: rel, bytes: buf.length, sha, ...(hits.length ? { redacted: [...new Set(hits)] } : {}) });
    staged.push({ rel, text });
  }
  manifest.included.sort((a, b) => a.path.localeCompare(b.path));
  manifest.changedPaths = changed.filter((p) => fileHashes[p] || !fs.existsSync(path.join(root, p)));

  const id = `ws_${sha256(Object.keys(fileHashes).sort().map((p) => `${p}\0${fileHashes[p]}`).join("\n")).slice(0, 12)}`;
  const dirty = worktreeChanged.length > 0;
  const revision = `${head ? head.slice(0, 10) : "nohead"}${dirty ? `+wt.${id.slice(3, 11)}` : ""}`;

  // Diff of included tracked files against HEAD (uncommitted work), redacted.
  let diffPatch = "";
  const diffPaths = manifest.changedPaths.filter((p) => !deniedPathReason(p));
  if (head && diffPaths.length) {
    try {
      diffPatch = git(root, ["diff", base ?? "HEAD", "--no-color", "--no-ext-diff", "--", ...diffPaths]);
    } catch {
      diffPatch = "";
    }
  }
  const untracked = diffPaths.filter((p) => !tryGit(root, ["ls-files", "--error-unmatch", p]));
  if (untracked.length) diffPatch += `\n# Untracked files (full content in repo/):\n${untracked.map((p) => `#   ${p}`).join("\n")}\n`;
  diffPatch = redact(diffPatch).text;

  const stageDir = path.join(cfg.stateDir, "snapshots", id);
  if (!fs.existsSync(path.join(stageDir, ".complete"))) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    for (const { rel, text } of staged) {
      const dest = path.join(stageDir, "repo", rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    }
    fs.mkdirSync(path.join(stageDir, "repo"), { recursive: true });
    fs.writeFileSync(path.join(stageDir, ".complete"), nowIso());
  }
  pruneSnapshots(path.join(cfg.stateDir, "snapshots"), 10, new Set([...keepIds, id]));

  return { id, repo, head, branch, dirty, revision, createdAt: nowIso(), manifest, fileHashes, diffPatch, stageDir, bytes: total };
}

function pruneSnapshots(dir: string, keep: number, pinned: Set<string>): void {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => !pinned.has(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(keep)) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function saveSnapshot(db: DB, s: Snapshot): void {
  db.prepare(
    "INSERT OR IGNORE INTO snapshots(id, created_at, head, dirty, revision, file_hashes, manifest, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(s.id, s.createdAt, s.head, s.dirty ? 1 : 0, s.revision, JSON.stringify(s.fileHashes), JSON.stringify(s.manifest), s.bytes);
}

/** Read a file as the lookout saw it (redacted staged copy). */
export function readSnapshotFile(s: Pick<Snapshot, "stageDir">, rel: string): string | null {
  const p = path.join(s.stageDir, "repo", rel);
  if (!p.startsWith(path.join(s.stageDir, "repo"))) return null;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Pack repo/ (snapshot) + context/ (job files) into one tar.gz so each run needs a single Files API upload.
 * Uses the system tar with an explicit -C per directory; nothing outside those two dirs is included.
 */
export function packBundle(s: Snapshot, contextDir: string, outPath: string): number {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync("tar", ["-czf", outPath, "-C", s.stageDir, "repo", "-C", path.dirname(contextDir), path.basename(contextDir)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" }, // no macOS ._ resource-fork entries
  });
  return fs.statSync(outPath).size;
}
