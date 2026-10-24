import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_REMOTE = "https://github.replit.internal/ukdarya-netizen/crypto-alt-bullet-trading-bot.git";
const ORIGINAL_EXPORT = "140e4979740781a4ce8b27bd4f307ea313c67417";
const MAX_FILE = 5 * 1024 * 1024;
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const fingerprint = (entry) => entry ? `${entry.mode}:${hash(entry.data)}` : null;
const same = (a, b) => fingerprint(a) === fingerprint(b);
const metadata = (snapshot) => Object.fromEntries([...snapshot].map(([p, e]) => [p, fingerprint(e)]));
const digest = (snapshot) => hash(JSON.stringify(Object.entries(metadata(snapshot)).sort()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function permitted(name) {
  const parts = name.split("/");
  if (!name || path.posix.isAbsolute(name) || /[\\\x00-\x1f\x7f]/.test(name) ||
      parts.some((p) => !p || p === "." || p === "..")) return false;
  if (parts.some((p) => [".git", ".local", ".agents", ".conversation", "attached_assets",
    "handoff", "node_modules", ".cache", "dist", "coverage", "generated-artifacts"].includes(p))) return false;
  return !parts.some((p) => /^\.env(?:\.|$)/i.test(p) && p !== ".env.example") &&
    !/\.(pem|p12|pfx|key|tsbuildinfo)$/i.test(name);
}

function validate(name, entry) {
  if (!permitted(name)) throw new Error(`Excluded path in source repository: ${name}`);
  if (!["100644", "100755"].includes(entry.mode)) throw new Error(`Non-regular file: ${name}`);
  if (entry.data.length > MAX_FILE || entry.data.includes(0)) throw new Error(`Binary/oversized file: ${name}`);
  const text = entry.data.toString("utf8");
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})|sk_live_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|[0-9]{8,12}:[A-Za-z0-9_-]{30,}/.test(text)) {
    throw new Error(`Possible credential in ${name}; synchronization paused`);
  }
}

export function planSync(base, local, remote) {
  const uploads = [], downloads = [], conflicts = [];
  for (const name of new Set([...Object.keys(base), ...local.keys(), ...remote.keys()])) {
    const l = local.get(name), r = remote.get(name), b = base[name] ?? null;
    if (same(l, r)) continue;
    const lc = fingerprint(l) !== b, rc = fingerprint(r) !== b;
    if (lc && rc) conflicts.push(name);
    else if (lc) uploads.push(name);
    else if (rc) downloads.push(name);
  }
  return { uploads, downloads, conflicts };
}

export class SourceSync {
  constructor({ root = process.cwd(), stateDir, remote = DEFAULT_REMOTE, branch = "main" } = {}) {
    this.root = path.resolve(root);
    this.stateDir = stateDir ?? path.join(this.root, ".local/github-sync");
    this.repo = path.join(this.stateDir, "repository");
    this.stateFile = path.join(this.stateDir, "baseline.json");
    this.remote = remote;
    this.branch = branch;
    fs.mkdirSync(this.stateDir, { recursive: true });
  }
  git(cwd, args, input) {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd, input, timeout: 60000, maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }
  ensureRepo() {
    if (!fs.existsSync(path.join(this.repo, ".git"))) {
      this.git(this.root, ["clone", "--no-checkout", "--", this.remote, this.repo]);
    }
    const actual = this.git(this.repo, ["remote", "get-url", "origin"]).toString().trim();
    if (actual !== this.remote) throw new Error("Source mirror remote mismatch");
    this.git(this.repo, ["fetch", "--quiet", "origin", this.branch]);
  }
  remoteSnapshot(ref) {
    const records = this.git(this.repo, ["ls-tree", "-rz", ref]).toString().split("\0").filter(Boolean);
    const entries = records.map((record) => {
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      const name = record.slice(tab + 1);
      if (type !== "blob" || !permitted(name) || !["100644", "100755"].includes(mode)) {
        throw new Error(`Unsafe source repository path/type: ${name}`);
      }
      return { mode, oid, name };
    });
    const blobs = this.git(this.repo, ["cat-file", "--batch"], entries.map((e) => e.oid).join("\n") + "\n");
    let offset = 0;
    const result = new Map();
    for (const entry of entries) {
      const end = blobs.indexOf(10, offset);
      const size = Number(blobs.subarray(offset, end).toString().split(" ")[2]);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Git object");
      const value = { mode: entry.mode, data: blobs.subarray(end + 1, end + 1 + size) };
      validate(entry.name, value);
      result.set(entry.name, value);
      offset = end + size + 2;
    }
    return result;
  }
  safePath(name, root = this.root) {
    if (!permitted(name)) throw new Error(`Excluded path: ${name}`);
    let current = root;
    for (const part of name.split("/")) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink in path: ${name}`);
      } catch (error) {
        if (error.code === "ENOENT") break;
        throw error;
      }
    }
    return path.join(root, name);
  }
  localSnapshot(extraNames = []) {
    const files = this.git(this.root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .toString().split("\0").filter(permitted);
    const result = new Map();
    for (const name of new Set([...files, ...extraNames])) {
      if (!permitted(name)) continue;
      const target = this.safePath(name);
      if (!fs.existsSync(target)) continue;
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) throw new Error(`Not a regular file: ${name}`);
      if (stat.size > MAX_FILE) throw new Error(`Oversized file: ${name}`);
      const entry = { mode: stat.mode & 0o111 ? "100755" : "100644", data: fs.readFileSync(target) };
      validate(name, entry);
      result.set(name, entry);
    }
    return result;
  }
  writeJson(file, value) {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  status(state, detail = {}) {
    this.writeJson(path.join(this.stateDir, "status.json"), { state, at: new Date().toISOString(), ...detail });
    console.log(`[GitHub Sync] ${state}`, JSON.stringify(detail));
  }
  initialize(baseline = ORIGINAL_EXPORT) {
    if (fs.existsSync(this.stateFile)) throw new Error("Baseline already initialized");
    this.ensureRepo();
    const base = this.remoteSnapshot(baseline);
    this.writeJson(this.stateFile, { version: 1, remote: this.remote, branch: this.branch,
      commit: baseline, files: metadata(base) });
    this.status("initialized", { files: base.size });
  }
  writeEntry(root, name, entry) {
    const target = this.safePath(name, root);
    if (!entry) {
      fs.rmSync(target, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Replace the file atomically, without following symlinks.
    const temp = path.join(path.dirname(target), `.github-sync-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temp, entry.data, { mode: entry.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
    fs.renameSync(temp, target);
  }
  async tick({ quietMs = 10000 } = {}) {
    if (fs.existsSync(path.join(this.stateDir, "PAUSE"))) {
      this.status("paused");
      return;
    }
    if (!fs.existsSync(this.stateFile)) throw new Error("Missing reviewed baseline; initialize explicitly");
    const state = JSON.parse(fs.readFileSync(this.stateFile));
    if (state.remote !== this.remote || state.branch !== this.branch) throw new Error("Baseline identity mismatch");
    this.ensureRepo();
    const ref = `refs/remotes/origin/${this.branch}`;
    const remote = this.remoteSnapshot(ref);
    const names = [...new Set([...Object.keys(state.files), ...remote.keys()])];
    const local = this.localSnapshot(names);
    const plan = planSync(state.files, local, remote);
    if (plan.conflicts.length) {
      this.status("conflict", { files: plan.conflicts });
      return;
    }
    if (plan.uploads.length || plan.downloads.length) {
      await sleep(quietMs);
      if (digest(local) !== digest(this.localSnapshot(names))) {
        this.status("waiting_for_stable_files");
        return;
      }
      // Only this disposable mirror is reset, never the workspace Git history.
      this.git(this.repo, ["reset", "--hard", ref]);
      for (const name of plan.uploads) this.writeEntry(this.repo, name, local.get(name));
      this.git(this.repo, ["add", "-A"]);
      if (this.git(this.repo, ["status", "--porcelain"]).length) {
        this.git(this.repo, ["-c", "user.name=Replit Source Sync", "-c",
          "user.email=source-sync@users.noreply.github.com", "commit", "-m", "Sync Replit source changes"]);
        if (digest(local) !== digest(this.localSnapshot(names))) {
          this.status("waiting_for_stable_files");
          return;
        }
        // Normal fast-forward push: concurrent remote commits reject the push.
        this.git(this.repo, ["push", "origin", `HEAD:refs/heads/${this.branch}`]);
      }
      // Never overwrite an edit made while the network request was running.
      if (digest(local) !== digest(this.localSnapshot(names))) {
        this.status("local_changed_during_push");
        return;
      }
      for (const name of plan.downloads) this.writeEntry(this.root, name, remote.get(name));
    }
    const merged = new Map(remote);
    for (const name of plan.uploads) {
      if (local.has(name)) merged.set(name, local.get(name));
      else merged.delete(name);
    }
    const commit = (plan.uploads.length || plan.downloads.length)
      ? this.git(this.repo, ["rev-parse", "HEAD"]).toString().trim()
      : this.git(this.repo, ["rev-parse", ref]).toString().trim();
    this.writeJson(this.stateFile, { ...state, commit, files: metadata(merged) });
    this.status("synced", { uploaded: plan.uploads.length, downloaded: plan.downloads.length, commit });
  }
}

async function main() {
  const sync = new SourceSync();
  if (process.argv.includes("--status")) {
    console.log(fs.readFileSync(path.join(sync.stateDir, "status.json"), "utf8"));
    return;
  }
  // Kernel-held lock is released on crash; no stale PID files or credentials.
  if (!process.env.GITHUB_SYNC_LOCK_HELD) {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("flock", ["-n", path.join(sync.stateDir, "worker.lock"),
      process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit", env: { ...process.env, GITHUB_SYNC_LOCK_HELD: "1" },
    });
    process.exitCode = result.status ?? 1;
    return;
  }
  if (process.argv.includes("--initialize")) sync.initialize();
  do {
    try { await sync.tick(); }
    catch (error) {
      // Do not print Git stderr: upstream auth errors can contain sensitive URLs.
      sync.status("error", { message: error.status !== undefined
        ? "Git operation failed; retrying without changing the workspace" : error.message });
      if (!process.argv.includes("--watch")) process.exitCode = 1;
    }
    if (!process.argv.includes("--watch")) break;
    await sleep(30000);
  } while (true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("[GitHub Sync] Startup failed"); process.exitCode = 1; });
}
