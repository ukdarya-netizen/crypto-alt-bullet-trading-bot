import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SourceSync, permitted } from "./github-sync.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-sync-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = path.join(dir, "workspace"), upstream = path.join(dir, "upstream.git");
  const other = path.join(dir, "other");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  fs.mkdirSync(local);
  git(local, "init", "-b", "main");
  git(local, "config", "user.name", "Sync test");
  git(local, "config", "user.email", "sync-test@example.invalid");
  fs.writeFileSync(path.join(local, "one.txt"), "one\n");
  fs.writeFileSync(path.join(local, "two.txt"), "two\n");
  fs.writeFileSync(path.join(local, ".gitignore"), ".local/\n.env\n");
  git(local, "add", ".");
  git(local, "commit", "-m", "initial");
  const baseline = git(local, "rev-parse", "HEAD");
  git(dir, "clone", "--bare", local, upstream);
  git(dir, "clone", upstream, other);
  git(other, "config", "user.name", "Remote editor");
  git(other, "config", "user.email", "remote@example.invalid");
  const sync = new SourceSync({ root: local, remote: upstream });
  sync.initialize(baseline);
  const remoteEdit = (name, content) => {
    if (content === null) fs.rmSync(path.join(other, name));
    else {
      fs.mkdirSync(path.dirname(path.join(other, name)), { recursive: true });
      fs.writeFileSync(path.join(other, name), content);
    }
    git(other, "add", "-A");
    git(other, "commit", "-m", "remote edit");
    git(other, "push", "origin", "main");
  };
  const status = () => JSON.parse(fs.readFileSync(path.join(sync.stateDir, "status.json")));
  return { dir, local, upstream, other, git, sync, remoteEdit, status, baseline };
}

test("excludes private data, credentials and traversal", () => {
  for (const p of [".agents/memory/a.md", "attached_assets/photo.png", "handoff/a",
    "a/.env.production", ".env", "key.pem", "../escape", "/etc/passwd", "a\\b", "a\nb",
    "node_modules/package/a", ".local/github-sync/baseline.json"]) assert.equal(permitted(p), false, p);
  assert.equal(permitted("artifacts/app/src/main.tsx"), true);
  assert.equal(permitted(".env.example"), true);
});

test("exchanges disjoint changes, additions, modes and deletes without uploading local history", async (t) => {
  const f = fixture(t);
  // A private workspace commit must never become an ancestor on GitHub.
  fs.mkdirSync(path.join(f.local, ".agents"));
  fs.writeFileSync(path.join(f.local, ".agents/private.txt"), "internal history\n");
  f.git(f.local, "add", ".agents");
  f.git(f.local, "commit", "-m", "internal private checkpoint");
  const privateCommit = f.git(f.local, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(f.local, "one.txt"), "local change\n");
  fs.writeFileSync(path.join(f.local, "new.sh"), "#!/bin/sh\necho ready\n", { mode: 0o755 });
  fs.writeFileSync(path.join(f.local, ".env"), "not for export\n");
  f.remoteEdit("two.txt", "remote change\n");
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "synced");
  assert.equal(fs.readFileSync(path.join(f.local, "two.txt"), "utf8"), "remote change\n");
  assert.equal(f.git(f.upstream, "show", "main:one.txt"), "local change");
  assert.match(f.git(f.upstream, "ls-tree", "main", "new.sh"), /^100755/);
  assert.equal(f.git(f.upstream, "ls-tree", "-r", "--name-only", "main").includes(".agents"), false);
  assert.equal(f.git(f.upstream, "ls-tree", "-r", "--name-only", "main").includes(".env\n"), false);
  assert.throws(() => f.git(f.upstream, "cat-file", "-e", privateCommit));
  // Restart reuses its durable baseline; do not resend source changes.
  const restarted = new SourceSync({ root: f.local, remote: f.upstream });
  await restarted.tick({ quietMs: 0 });
  assert.equal(f.status().uploaded, 0);
  assert.equal(f.status().downloaded, 0);
  f.git(f.other, "pull", "--ff-only");
  f.remoteEdit("two.txt", null);
  fs.rmSync(path.join(f.local, "one.txt"));
  await restarted.tick({ quietMs: 0 });
  assert.equal(fs.existsSync(path.join(f.local, "two.txt")), false);
  assert.throws(() => f.git(f.upstream, "show", "main:one.txt"));
});

test("same-file conflicts pause the whole exchange and resume after explicit resolution", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.local, "one.txt"), "local version\n");
  fs.writeFileSync(path.join(f.local, "other.txt"), "must not upload yet\n");
  f.remoteEdit("one.txt", "remote version\n");
  const before = f.git(f.upstream, "rev-parse", "main");
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "conflict");
  assert.deepEqual(f.status().files, ["one.txt"]);
  assert.equal(f.git(f.upstream, "rev-parse", "main"), before);
  assert.equal(fs.readFileSync(path.join(f.local, "one.txt"), "utf8"), "local version\n");
  fs.writeFileSync(path.join(f.local, "one.txt"), "remote version\n");
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "synced");
  assert.equal(f.git(f.upstream, "show", "main:other.txt"), "must not upload yet");
});

test("rejects symlinks (including dangling), binary files and recognizable credentials", async (t) => {
  const f = fixture(t);
  fs.symlinkSync("/no/such/private/file", path.join(f.local, "link"));
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Symlink/);
  fs.rmSync(path.join(f.local, "link"));
  fs.writeFileSync(path.join(f.local, "binary"), Buffer.from([0, 1, 2]));
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Binary/);
  fs.rmSync(path.join(f.local, "binary"));
  fs.writeFileSync(path.join(f.local, "oops.txt"), "ghp_" + "x".repeat(40));
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /credential/);
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("exchanges PNG assets in both directions without changing their bytes", async (t) => {
  const f = fixture(t);
  const localName = "artifacts/app/public/local.png";
  const remoteName = "artifacts/app/public/apple-touch-icon.png";
  fs.mkdirSync(path.dirname(path.join(f.local, localName)), { recursive: true });
  fs.writeFileSync(path.join(f.local, localName), png);
  f.remoteEdit(remoteName, png);
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "synced");
  assert.deepEqual(fs.readFileSync(path.join(f.local, remoteName)), png);
  assert.equal(
    f.git(f.upstream, "rev-parse", `main:${localName}`),
    f.git(f.local, "hash-object", localName),
  );
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().uploaded, 0);
  assert.equal(f.status().downloaded, 0);
});

test("PNG exceptions require both a matching extension and a PNG signature", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.local, "fake.png"), Buffer.from([0, 1, 2]));
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Binary/);
  fs.rmSync(path.join(f.local, "fake.png"));
  f.remoteEdit("not-a-png.bin", png);
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Binary/);
  assert.equal(fs.existsSync(path.join(f.local, "not-a-png.bin")), false);
});

test("PNG assets retain the size limit and recognizable credential checks", async (t) => {
  const f = fixture(t);
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  png.copy(oversized);
  fs.writeFileSync(path.join(f.local, "oversized.png"), oversized);
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Oversized/);
  fs.rmSync(path.join(f.local, "oversized.png"));
  f.remoteEdit("credential.png", Buffer.concat([png, Buffer.from("ghp_" + "x".repeat(40))]));
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /credential/);
  assert.equal(fs.existsSync(path.join(f.local, "credential.png")), false);
});

test("rejects unsafe remote paths and never imports them", async (t) => {
  const f = fixture(t);
  f.remoteEdit("handoff/private.txt", "never import\n");
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Unsafe source/);
  assert.equal(fs.existsSync(path.join(f.local, "handoff")), false);
});

test("does not publish edits made during the quiet period; runtime pause works", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.local, "one.txt"), "edit 1\n");
  const pending = f.sync.tick({ quietMs: 80 });
  setTimeout(() => fs.writeFileSync(path.join(f.local, "one.txt"), "edit 2\n"), 10);
  await pending;
  assert.equal(f.status().state, "waiting_for_stable_files");
  assert.equal(f.git(f.upstream, "show", "main:one.txt"), "one");
  fs.writeFileSync(path.join(f.sync.stateDir, "PAUSE"), "");
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "paused");
  assert.throws(() => f.sync.initialize(f.baseline), /already initialized/);
});

test("concurrent GitHub commit rejects the push without overwriting either workspace", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.local, "one.txt"), "local change\n");
  const originalGit = f.sync.git.bind(f.sync);
  let injected = false;
  f.sync.git = (cwd, args, input) => {
    if (args[0] === "push" && !injected) {
      injected = true;
      f.remoteEdit("two.txt", "concurrent remote change\n");
    }
    return originalGit(cwd, args, input);
  };
  await assert.rejects(f.sync.tick({ quietMs: 0 }));
  assert.equal(f.git(f.upstream, "show", "main:one.txt"), "one");
  assert.equal(fs.readFileSync(path.join(f.local, "two.txt"), "utf8"), "two\n");
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "synced");
  assert.equal(f.git(f.upstream, "show", "main:one.txt"), "local change");
  assert.equal(fs.readFileSync(path.join(f.local, "two.txt"), "utf8"), "concurrent remote change\n");
});

test("missing mirror metadata recovers without resetting the baseline or publishing private history", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.local, "one.txt"), "first local change\n");
  await f.sync.tick({ quietMs: 0 });
  const baselineBefore = fs.readFileSync(f.sync.stateFile, "utf8");
  fs.mkdirSync(path.join(f.local, ".agents"));
  fs.writeFileSync(path.join(f.local, ".agents/private.txt"), "private checkpoint\n");
  f.git(f.local, "add", ".");
  f.git(f.local, "commit", "-m", "private workspace checkpoint");
  const privateHead = f.git(f.local, "rev-parse", "HEAD");
  // Model restoration losing Git metadata but retaining checkout and state.
  fs.rmSync(f.sync.gitDir, { recursive: true, force: true });
  assert.throws(() => f.sync.git(f.sync.repo, ["reset", "--hard", "HEAD"]), /Missing isolated/);
  assert.equal(f.git(f.local, "rev-parse", "HEAD"), privateHead);
  assert.equal(fs.readFileSync(f.sync.stateFile, "utf8"), baselineBefore);
  f.git(f.other, "pull", "--ff-only");
  f.remoteEdit("two.txt", "remote change after restoration\n");
  fs.writeFileSync(path.join(f.local, "one.txt"), "second local change\n");
  const restored = new SourceSync({ root: f.local, remote: f.upstream });
  await restored.tick({ quietMs: 0 });
  assert.equal(f.status().state, "synced");
  assert.equal(f.git(f.local, "rev-parse", "HEAD"), privateHead);
  assert.equal(f.git(f.upstream, "show", "main:one.txt"), "second local change");
  assert.equal(fs.readFileSync(path.join(f.local, "two.txt"), "utf8"), "remote change after restoration\n");
  assert.throws(() => f.git(f.upstream, "cat-file", "-e", privateHead));
  assert.equal(fs.existsSync(path.join(restored.repo, ".git")), false);
  assert.equal(restored.git(restored.repo, ["rev-parse", "--absolute-git-dir"]).toString().trim(), restored.gitDir);
});

test("loss of metadata mid-cycle fails closed before any push or workspace import", async (t) => {
  const f = fixture(t);
  const head = f.git(f.local, "rev-parse", "HEAD");
  const remoteHead = f.git(f.upstream, "rev-parse", "main");
  fs.writeFileSync(path.join(f.local, "one.txt"), "unpublished local edit\n");
  const originalGit = f.sync.git.bind(f.sync);
  f.sync.git = (cwd, args, input) => {
    if (args[0] === "reset") fs.rmSync(f.sync.gitDir, { recursive: true, force: true });
    return originalGit(cwd, args, input);
  };
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Missing isolated/);
  assert.equal(f.git(f.local, "rev-parse", "HEAD"), head);
  assert.equal(f.git(f.upstream, "rev-parse", "main"), remoteHead);
  assert.equal(fs.readFileSync(path.join(f.local, "one.txt"), "utf8"), "unpublished local edit\n");
});

test("rejects metadata symlinks and wrong remotes without touching the parent repository", async (t) => {
  const f = fixture(t);
  const head = f.git(f.local, "rev-parse", "HEAD");
  fs.rmSync(f.sync.gitDir, { recursive: true, force: true });
  fs.symlinkSync(path.join(f.local, ".git"), f.sync.gitDir);
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /Unsafe source mirror/);
  assert.equal(f.git(f.local, "rev-parse", "HEAD"), head);
  fs.rmSync(f.sync.gitDir);
  f.sync.ensureRepo();
  f.sync.git(f.sync.repo, ["remote", "set-url", "origin", f.other]);
  await assert.rejects(f.sync.tick({ quietMs: 0 }), /remote mismatch/);
});

test("recovery retains conflicts and does not upload abandoned checkout files", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sync.repo, "abandoned.txt"), "untracked mirror file\n");
  fs.rmSync(f.sync.gitDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(f.local, "one.txt"), "local version\n");
  f.remoteEdit("one.txt", "remote version\n");
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "conflict");
  fs.writeFileSync(path.join(f.local, "one.txt"), "remote version\n");
  fs.writeFileSync(path.join(f.local, "new.txt"), "reviewed local addition\n");
  await f.sync.tick({ quietMs: 0 });
  assert.equal(f.status().state, "synced");
  assert.throws(() => f.git(f.upstream, "show", "main:abandoned.txt"));
  assert.equal(f.git(f.upstream, "show", "main:new.txt"), "reviewed local addition");
});
