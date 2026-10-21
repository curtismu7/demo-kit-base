#!/usr/bin/env node
// base-sync: pull-sync of base-owned files into a demo repo (design v2.2, section 9.2).
// Commands: --init, --check [--remote], --update, --release, --selftest. Node only, no dependencies.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LOCK = 'demo-kit.lock.json';
const WORKFLOWS = '.github/workflows/';
const MAX_OVERRIDE_DAYS = 30;
const DEFAULT_REPO = 'git@github.com:cmuir_pingcorp/demo-kit-base.git';

export const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function hashFile(root, p) {
  try {
    return sha(fs.readFileSync(path.join(root, p)));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw e;
  }
}

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
};

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const writeJson = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2) + '\n');

// A manifest or lock path must stay inside the demo root: relative, no '..', no backslash or NUL.
export function unsafePath(p, root) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return true;
  if (p.split('/').includes('..')) return true;
  const rel = path.relative(path.resolve(root), path.resolve(root, p));
  return !rel || rel.startsWith('..') || path.isAbsolute(rel);
}
const assertSafePaths = (root, paths) => {
  const bad = paths.filter((p) => unsafePath(p, root));
  if (bad.length) throw new Error(`unsafe path outside the demo root: ${bad.map((p) => JSON.stringify(p)).join(', ')}`);
};

// Real-path containment (policy): a path is refused if its real parent directory leaves the real
// demo root, if any ancestor is a dangling or looping symlink, or if the path itself is a symlink
// (we never write, delete or read THROUGH a symlinked file, even one pointing inside the root).
// A symlinked DIRECTORY whose real target stays inside the root is allowed.
export function symlinkIssue(root, p) {
  const bad = (why) => `${JSON.stringify(p)} ${why}`;
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch (e) { return bad(`cannot resolve the demo root (${e.code})`); }
  const full = path.join(root, p);
  try {
    if (fs.lstatSync(full).isSymbolicLink()) return bad('is a symlink; base-sync does not write, delete or read through symlinked files');
  } catch (e) {
    if (e.code === 'ELOOP') return bad('crosses a symlink loop');
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return bad(`cannot be inspected (${e.code})`);
  }
  let cur = path.dirname(full);
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      const rel = path.relative(realRoot, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return bad('resolves through a symlink to outside the demo root');
      return null;
    } catch (e) {
      if (e.code === 'ELOOP') return bad('crosses a symlink loop');
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return bad(`cannot be resolved (${e.code})`);
      try { fs.lstatSync(cur); return bad('crosses a dangling symlink'); } catch { /* really absent: go up */ }
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
}
const assertContained = (root, p) => {
  const i = symlinkIssue(root, p);
  if (i) throw new Error(`refusing path ${i}`);
};
// hashFile for demo files: refuses symlink escapes before reading.
const safeHash = (root, p) => { assertContained(root, p); return hashFile(root, p); };

// ---- lock loading and schema -----------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function lockProblem(lock, { needBase = false } = {}) {
  const f = (m) => `${LOCK}: ${m}`;
  if (!isObj(lock)) return f('must be a JSON object');
  if (lock.base !== undefined || needBase) {
    if (!isObj(lock.base)) return f('field "base" must be an object');
    if (needBase && typeof lock.base.repo !== 'string') return f('field "base.repo" must be a string');
    if (lock.base.version != null && typeof lock.base.version !== 'string') return f('field "base.version" must be a string or null');
  }
  if (lock.files !== undefined) {
    if (!isObj(lock.files)) return f('field "files" must be an object');
    for (const [k, e] of Object.entries(lock.files)) {
      if (!isObj(e)) return f(`field "files.${k}" must be an object with sha256 and group`);
      if (e.sha256 !== null && typeof e.sha256 !== 'string') return f(`field "files.${k}.sha256" must be a string or null`);
      if (typeof e.group !== 'string') return f(`field "files.${k}.group" must be a string`);
    }
  }
  if (lock.seeded !== undefined) {
    if (!isObj(lock.seeded)) return f('field "seeded" must be an object');
    for (const [k, v] of Object.entries(lock.seeded)) if (typeof v !== 'string') return f(`field "seeded.${k}" must be a hash string`);
  }
  for (const k of ['demoPaths', 'adopted']) {
    if (lock[k] !== undefined && (!Array.isArray(lock[k]) || lock[k].some((x) => typeof x !== 'string'))) return f(`field "${k}" must be an array of strings`);
  }
  if (lock.overrides !== undefined) {
    if (!Array.isArray(lock.overrides)) return f('field "overrides" must be an array');
    const i = lock.overrides.findIndex((o) => !isObj(o));
    if (i >= 0) return f(`field "overrides[${i}]" must be an object`);
  }
  return null;
}
// Returns { lock } or { error } (one clean line); never throws on a bad or hostile lock.
export function loadLock(root, opts) {
  const issue = symlinkIssue(root, LOCK);
  if (issue) return { error: `${LOCK}: refusing path ${issue}` };
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(root, LOCK), 'utf8')); } catch (e) {
    return { error: `${LOCK}: ${e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot be read (${e.code || e.message})`}` };
  }
  const error = lockProblem(lock, opts);
  return error ? { error } : { lock };
}

// ---- globs -----------------------------------------------------------------
export function globToRegExp(glob) {
  let g = glob.endsWith('/') ? `${glob}**` : glob;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}
export const matchesAny = (globs, p) => (globs || []).some((g) => globToRegExp(g).test(p));

// ---- the three-hash rule ---------------------------------------------------
// L = local hash (null if missing), B = hash in the target base release,
// R = hash recorded in the lock at the last sync (null if never synced).
export function classify3(L, B, R) {
  if (R !== null && R !== undefined) {
    if (L === R) return B === R ? 'unchanged' : 'overwrite';
    if (B === R) return 'local-only';
    return L === B ? 'converged' : 'conflict';
  }
  if (L === null) return 'add';
  return L === B ? 'converged' : 'conflict';
}

// ---- lock helpers ----------------------------------------------------------
export const isAdopted = (lock, group) => !Array.isArray(lock.adopted) || lock.adopted.includes(group);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);

export function overrideProblems(lock, now) {
  const out = [];
  const limit = addDays(now, MAX_OVERRIDE_DAYS);
  for (const o of lock.overrides || []) {
    const missing = ['path', 'hash', 'reason', 'issue', 'expires'].filter((k) => !o[k]);
    if (missing.length) { out.push({ path: o.path || '?', kind: 'override-invalid', msg: `override lacks ${missing.join(', ')}` }); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.expires)) { out.push({ path: o.path, kind: 'override-invalid', msg: 'expires must be YYYY-MM-DD' }); continue; }
    if (!lock.files?.[o.path]) out.push({ path: o.path, kind: 'override-invalid', msg: 'override for a path the base does not own' });
    if (o.expires < now) out.push({ path: o.path, kind: 'override-expired', msg: `override expired ${o.expires}` });
    else if (o.expires > limit) out.push({ path: o.path, kind: 'override-invalid', msg: `override expires beyond ${MAX_OVERRIDE_DAYS} days` });
  }
  return out;
}

const validOverride = (lock, p, L, now) =>
  (lock.overrides || []).find((o) => o.path === p && o.hash === L && o.expires >= now && o.reason && o.issue);

// ---- file listing ----------------------------------------------------------
function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts });
}

export function listFiles(root) {
  if (fs.existsSync(path.join(root, '.git'))) {
    const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
    if (r.status === 0) {
      return [...new Set(r.stdout.split('\0').filter(Boolean))].filter((p) => fs.existsSync(path.join(root, p))).sort();
    }
  }
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel); else out.push(rel);
    }
  })('');
  return out.sort();
}

// ---- deps and scripts ------------------------------------------------------
const majorOf = (range) => (String(range).match(/\d+/) || [null])[0];

export function depProblems(root) {
  const out = [];
  const deps = readJson(path.join(root, 'base/required-deps.json'), {});
  const scripts = readJson(path.join(root, 'base/required-scripts.json'), []);
  const have = {};
  for (const pj of ['package.json', 'server/package.json', 'web/package.json']) {
    const j = readJson(path.join(root, pj), {});
    Object.assign(have, j.dependencies, j.devDependencies);
  }
  for (const [name, major] of Object.entries(deps)) {
    if (!(name in have)) out.push({ path: 'package.json', kind: 'dep', msg: `missing dependency ${name} (major ${majorOf(major)})` });
    else if (majorOf(have[name]) !== majorOf(major)) out.push({ path: 'package.json', kind: 'dep', msg: `dependency ${name} is ${have[name]}, base needs major ${majorOf(major)}` });
  }
  const own = readJson(path.join(root, 'package.json'), {}).scripts || {};
  for (const s of scripts) if (!(s in own)) out.push({ path: 'package.json', kind: 'script', msg: `missing npm script "${s}"` });
  return out;
}

// ---- --check ---------------------------------------------------------------
export function check(root, { now = today() } = {}) {
  const lockFile = path.join(root, LOCK);
  if (!fs.existsSync(lockFile)) return { ok: false, problems: [{ path: LOCK, kind: 'no-lock', msg: 'no lock file; run --init' }], pending: [] };
  const loaded = loadLock(root);
  if (loaded.error) return { ok: false, problems: [{ path: LOCK, kind: 'bad-lock', msg: loaded.error }], pending: [] };
  const lock = loaded.lock;
  const problems = [...overrideProblems(lock, now)];
  const pending = [];
  for (const p of [...Object.keys(lock.files || {}), ...Object.keys(lock.seeded || {})]) {
    if (unsafePath(p, root)) problems.push({ path: p, kind: 'unsafe-path', msg: 'lock path is absolute or outside the demo root' });
  }
  for (const p of Object.keys(lock.files || {})) {
    const i = unsafePath(p, root) ? null : symlinkIssue(root, p);
    if (i) problems.push({ path: p, kind: 'unsafe-path', msg: `refusing path ${i}` });
  }
  if (problems.some((x) => x.kind === 'unsafe-path')) return { ok: false, problems, pending };
  for (const [p, e] of Object.entries(lock.files || {})) {
    if (!isAdopted(lock, e.group)) { pending.push(p); continue; }
    const L = hashFile(root, p);
    if (e.sha256 === null) { problems.push({ path: p, kind: 'unsynced', msg: 'adopted but never synced; run --update' }); continue; }
    if (L === e.sha256) continue;
    if (validOverride(lock, p, L, now)) continue;
    problems.push({ path: p, kind: L === null ? 'missing' : 'modified', msg: L === null ? 'base-owned file is missing' : 'base-owned file was edited locally' });
  }
  const seeded = Object.keys(lock.seeded || {});
  for (const p of listFiles(root)) {
    if (p === LOCK || lock.files?.[p] || seeded.includes(p) || p.startsWith('demo/') || matchesAny(lock.demoPaths, p)) continue;
    problems.push({ path: p, kind: 'unclassified', msg: 'in no manifest row, seeded list, demoPaths or demo/' });
  }
  problems.push(...depProblems(root));
  return { ok: problems.length === 0, problems, pending };
}

// ---- planning --------------------------------------------------------------
export function plan({ root, lock, manifest, baseDir, includeWorkflows = false, acceptRemoval = [], now = today() }) {
  assertSafePaths(root, [...manifest.map((r) => r.path), ...Object.keys(lock.files || {}), ...Object.keys(lock.seeded || {})]);
  const out = { writes: [], deletes: [], conflicts: [], removals: [], localOnly: [], skippedWorkflows: [], overrideKept: [], seeded: {}, files: {} };
  const rows = new Map(manifest.map((r) => [r.path, r]));
  const content = (p) => fs.readFileSync(path.join(baseDir, p));
  for (const row of manifest) {
    const p = row.path;
    const L = safeHash(root, p);
    if (row.seeded) {
      if (L === null) { out.writes.push({ path: p, data: content(p) }); out.seeded[p] = row.sha256; } else out.seeded[p] = lock.seeded?.[p] ?? L;
      continue;
    }
    const old = lock.files?.[p];
    if (!isAdopted(lock, row.group)) { out.files[p] = { sha256: old?.sha256 ?? null, group: row.group }; continue; }
    const B = row.sha256;
    const R = old?.sha256 ?? null;
    const keep = old ? { sha256: old.sha256, group: row.group } : null;
    const ov = validOverride(lock, p, L, now);
    let kind = classify3(L, B, R);
    if (ov && L !== B && (kind === 'conflict' || kind === 'overwrite' || kind === 'local-only')) {
      out.overrideKept.push(p); if (keep) out.files[p] = keep; continue;
    }
    if (p.startsWith(WORKFLOWS) && !includeWorkflows && ['overwrite', 'add', 'conflict'].includes(kind)) {
      out.skippedWorkflows.push(p); if (keep) out.files[p] = keep; continue;
    }
    if (kind === 'conflict') { out.conflicts.push({ path: p, data: content(p) }); out.files[p] = keep || { sha256: null, group: row.group }; continue; }
    if (kind === 'local-only') { out.localOnly.push(p); out.files[p] = keep; continue; }
    if (kind === 'overwrite' || kind === 'add') out.writes.push({ path: p, data: content(p) });
    out.files[p] = { sha256: B, group: row.group };
  }
  for (const [p, e] of Object.entries(lock.files || {})) {
    if (rows.has(p)) continue;
    if (!isAdopted(lock, e.group)) continue; // pending rows vanish quietly
    if (acceptRemoval.includes(p)) { if (safeHash(root, p) === e.sha256) out.deletes.push(p); } else out.removals.push(p);
  }
  return out;
}

// ---- base fetching ---------------------------------------------------------
function gitEnv(env) {
  const e = { ...env };
  if (e.BASE_READ_KEY_FILE) e.GIT_SSH_COMMAND = `ssh -i ${e.BASE_READ_KEY_FILE} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  return e;
}

const semver = (t) => (/^v(\d+)\.(\d+)\.(\d+)$/.exec(t) || []).slice(1).map(Number);
const cmpVer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

export function latestTag(repo, env = process.env) {
  const r = git(['ls-remote', '--tags', '--refs', repo], { env: gitEnv(env) });
  if (r.status !== 0) throw new Error(`cannot list tags of ${repo}: ${r.stderr.trim()}`);
  const tags = r.stdout.split('\n').map((l) => l.split('refs/tags/')[1]).filter((t) => t && semver(t).length === 3);
  if (!tags.length) throw new Error('base has no vX.Y.Z tags');
  return tags.sort(cmpVer).pop();
}

function fetchBase(repo, tag, env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'base-sync-'));
  const dir = path.join(tmp, 'base');
  const r = git(['clone', '--quiet', '--depth', '1', '--branch', tag, repo, dir], { env: gitEnv(env) });
  if (r.status !== 0) throw new Error(`clone of ${repo} at ${tag} failed: ${r.stderr.trim()}`);
  const commit = git(['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
  return { tmp, dir, commit, manifest: readJson(path.join(dir, 'base/manifest.json')) };
}

// The downloaded updater runs with no token in its environment (design 9.2).
export function runSelftest(baseDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'base-sync-st-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const script = path.join(baseDir, 'scripts/base-sync.mjs');
  if (!fs.existsSync(script)) return { ok: false, msg: 'release has no scripts/base-sync.mjs' };
  const r = spawnSync(process.execPath, [script, '--selftest'], {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, LANG: process.env.LANG || 'C' },
    encoding: 'utf8',
    timeout: 60000,
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r.status === 0 ? { ok: true } : { ok: false, msg: `selftest of the new updater failed (exit ${r.status ?? r.signal})` };
}

// ---- --init / --update -----------------------------------------------------
const defaultIo = { writeFile: fs.writeFileSync, rename: fs.renameSync, rm: (f) => fs.rmSync(f, { force: true }) };
const readOrNull = (f) => { try { return fs.readFileSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// Stage every write (and the lock) as a temp file next to its target; only when all temps exist
// rename them in one pass, lock last. Any failure removes the temps, restores what was renamed or
// deleted, and removes directories this call created, leaving the tree as it was.
export function applyPlan(root, lock, pl, baseInfo, repo, tag, io = defaultIo) {
  const next = { ...lock, base: { repo, version: tag, commit: baseInfo.commit }, files: Object.fromEntries(Object.entries(pl.files).sort()), seeded: pl.seeded };
  const ops = [...pl.writes.map((w) => ({ p: w.path, data: w.data })), { p: LOCK, data: JSON.stringify(next, null, 2) + '\n' }];
  for (const p of [...ops.map((o) => o.p), ...pl.deletes]) assertContained(root, p);
  const temps = [];
  const createdDirs = [];
  const done = []; // { file, orig } for renamed targets and deleted files
  try {
    ops.forEach((o, i) => {
      o.file = path.join(root, o.p);
      const made = fs.mkdirSync(path.dirname(o.file), { recursive: true });
      if (made) createdDirs.push(made);
      o.tmp = `${o.file}.tmp-${process.pid}-${i}`;
      temps.push(o.tmp);
      io.writeFile(o.tmp, o.data);
    });
    const lockOp = ops.pop();
    for (const o of [...ops, ...pl.deletes.map((p) => ({ del: path.join(root, p) })), lockOp]) {
      const file = o.del || o.file;
      done.push({ file, orig: readOrNull(file) });
      if (o.del) io.rm(file); else io.rename(o.tmp, file);
    }
  } catch (e) {
    for (const t of temps) fs.rmSync(t, { force: true });
    for (const { file, orig } of done.reverse()) {
      if (orig === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, orig);
    }
    for (const d of createdDirs.reverse()) fs.rmSync(d, { recursive: true, force: true });
    throw e;
  }
  return next;
}

export function sync({ root, mode, repo, tag, adopt, demoPaths, includeWorkflows = false, allowDowngrade = false, acceptRemoval = [], env = process.env, now = today() }) {
  const lines = [];
  const lockFile = path.join(root, LOCK);
  let lock;
  if (mode === 'init') {
    if (fs.existsSync(lockFile)) return { code: 1, lines: [`${LOCK} already exists; use --update`] };
    lock = { base: { repo, version: null, commit: null }, files: {}, seeded: {}, demoPaths: demoPaths || [], overrides: [] };
    if (adopt) lock.adopted = adopt;
  } else {
    if (!fs.existsSync(lockFile)) return { code: 1, lines: [`no ${LOCK}; run --init`] };
    const loaded = loadLock(root, { needBase: true });
    if (loaded.error) return { code: 1, lines: [loaded.error] };
    lock = loaded.lock;
    repo = repo || lock.base.repo;
    if (adopt) lock.adopted = [...new Set([...(lock.adopted || []), ...adopt])];
  }
  tag = tag || latestTag(repo, env);
  if (mode === 'update' && lock.base.version && cmpVer(tag, lock.base.version) < 0 && !allowDowngrade) {
    return { code: 1, lines: [`refusing downgrade ${lock.base.version} -> ${tag}; pass --allow-downgrade`] };
  }
  const info = fetchBase(repo, tag, env);
  try {
    const st = runSelftest(info.dir);
    if (!st.ok) return { code: 1, lines: [`aborted, nothing changed: ${st.msg}`] };
    let pl;
    try {
      pl = plan({ root, lock, manifest: info.manifest, baseDir: info.dir, includeWorkflows, acceptRemoval, now });
      assertSafePaths(root, acceptRemoval);
    } catch (e) {
      return { code: 1, lines: [`aborted, nothing changed: ${e.message}`] };
    }
    try {
      assertContained(root, LOCK);
      for (const c of pl.conflicts) assertContained(root, `${c.path}.base-new`);
    } catch (e) {
      return { code: 1, lines: [`aborted, nothing changed: ${e.message}`] };
    }
    for (const c of pl.conflicts) {
      writeAtomic(path.join(root, `${c.path}.base-new`), c.data);
      lines.push(`conflict: ${c.path} (base version written to ${c.path}.base-new)`);
    }
    for (const p of pl.removals) lines.push(`removed in base: ${p} (rerun with --accept-removal ${p} to drop it)`);
    if (pl.conflicts.length || pl.removals.length) {
      lines.push('stopped, nothing else changed');
      return { code: 1, lines };
    }
    try {
      applyPlan(root, lock, pl, info, repo, tag);
    } catch (e) {
      return { code: 1, lines: [`aborted, nothing changed: ${e.message}`] };
    }
    for (const p of pl.localOnly) lines.push(`kept locally edited file: ${p} (--check will fail until reverted or overridden)`);
    for (const p of pl.overrideKept) lines.push(`kept by override: ${p}`);
    if (pl.skippedWorkflows.length) lines.push(`workflow files NOT written (apply locally with --update --include-workflows): ${pl.skippedWorkflows.join(', ')}`);
    lines.push(`${mode === 'init' ? 'initialised at' : 'updated to'} ${tag}: ${pl.writes.length} written, ${pl.deletes.length} removed`);
    const need = depProblems(root);
    for (const n of need) lines.push(`add by hand: ${n.msg}`);
    return { code: 0, lines };
  } finally {
    fs.rmSync(info.tmp, { recursive: true, force: true });
  }
}

export function remoteCheck(root, env = process.env) {
  const loaded = loadLock(root, { needBase: true });
  if (loaded.error) return { code: 1, lines: [loaded.error] };
  const lock = loaded.lock;
  const latest = latestTag(lock.base.repo, env);
  const behind = cmpVer(latest, lock.base.version) > 0;
  return { code: 0, lines: [behind ? `base ${latest} is available (you are on ${lock.base.version})` : `up to date at ${lock.base.version}`] };
}

// ---- --release (run in the base repo) ---------------------------------------
export function release({ root, version, env = process.env }) {
  const fail = (m) => ({ code: 1, lines: [`release refused: ${m}`] });
  if (!/^v\d+\.\d+\.\d+$/.test(version || '')) return fail('--version=vX.Y.Z required');
  if (git(['status', '--porcelain'], { cwd: root }).stdout.trim()) return fail('working tree is not clean');
  if (git(['tag', '--list', version], { cwd: root }).stdout.trim()) return fail(`tag ${version} exists`);
  const cfg = readJson(path.join(root, 'base/groups.json'));
  const files = git(['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);

  const idsFile = env.FORBIDDEN_STRINGS_FILE;
  if (!idsFile || !fs.existsSync(idsFile)) return fail('FORBIDDEN_STRINGS_FILE must name the forbidden-strings file');
  const bad = fs.readFileSync(idsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const p of files) {
    const text = fs.readFileSync(path.join(root, p)).toString('latin1');
    if (bad.some((s) => text.includes(s))) return fail(`forbidden string in ${p}`);
  }
  const gate = path.join(root, 'scripts/check-forbidden-strings.mjs');
  if (fs.existsSync(gate) && spawnSync(process.execPath, [gate], { cwd: root, env, stdio: 'ignore' }).status !== 0) return fail('check-forbidden-strings failed');
  const api = path.join(root, 'server/src/__tests__/baseApi.test.js');
  if (fs.existsSync(api) && spawnSync(process.execPath, ['--test', api], { cwd: root, env, stdio: 'ignore' }).status !== 0) return fail('baseApi.test.js failed');

  const rows = [];
  for (const p of files) {
    if (p === 'base/manifest.json') continue;
    const seeded = (cfg.seeded || []).includes(p);
    const group = seeded ? 'seeded' : Object.keys(cfg.groups || {}).find((g) => matchesAny(cfg.groups[g], p));
    if (!group) continue;
    rows.push({ path: p, sha256: hashFile(root, p), group, ...(seeded ? { seeded: true } : {}) });
  }
  writeJson(path.join(root, 'base/manifest.json'), rows.sort((a, b) => (a.path < b.path ? -1 : 1)));
  for (const args of [['add', 'base/manifest.json'], ['commit', '-q', '-m', `release ${version}`], ['tag', version]]) {
    const r = git(args, { cwd: root, env });
    if (r.status !== 0) return fail(`git ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return { code: 0, lines: [`released ${version}: ${rows.length} manifest rows`] };
}

// ---- --selftest (built-in fixtures only; never touches the environment) -----
export function selftest() {
  const table = [
    [['a', 'a', 'a'], 'unchanged'], [['a', 'b', 'a'], 'overwrite'], [['x', 'a', 'a'], 'local-only'],
    [['x', 'b', 'a'], 'conflict'], [['b', 'b', 'a'], 'converged'], [[null, 'b', null], 'add'],
  ];
  for (const [args, want] of table) if (classify3(...args) !== want) return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'base-sync-self-'));
  try {
    fs.writeFileSync(path.join(tmp, 'f'), 'one');
    const lock = { files: { f: { sha256: sha('one'), group: 'G1' } }, demoPaths: [], overrides: [] };
    writeJson(path.join(tmp, LOCK), lock);
    if (!check(tmp).ok) return false;
    fs.writeFileSync(path.join(tmp, 'f'), 'two');
    return !check(tmp).ok;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- CLI -------------------------------------------------------------------
const VALUE_FLAGS = new Set(['to', 'base', 'repo', 'adopt', 'demo-paths', 'accept-removal', 'version', 'root']);

export function parseArgs(argv) {
  const o = { acceptRemoval: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`unexpected argument ${argv[i]}`);
    let [, k, v] = m;
    if (VALUE_FLAGS.has(k) && v === undefined) v = argv[++i];
    if (k === 'accept-removal') o.acceptRemoval.push(v); else o[k] = v === undefined ? true : v;
  }
  return o;
}

export function main(argv, env = process.env) {
  const a = parseArgs(argv);
  const root = path.resolve(a.root || process.cwd());
  const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  let res;
  if (a.selftest) res = { code: selftest() ? 0 : 1, lines: [] };
  else if (a.check) {
    const r = check(root);
    const lines = r.problems.map((p) => `${p.kind}: ${p.path}: ${p.msg}`);
    if (r.pending.length) lines.push(`pending (not adopted yet): ${r.pending.length} files`);
    lines.push(r.ok ? 'base-sync check: ok' : `base-sync check: ${r.problems.length} problem(s)`);
    res = { code: r.ok ? 0 : 1, lines };
    if (r.ok && a.remote) { const rr = remoteCheck(root, env); res.lines.push(...rr.lines); }
  } else if (a.init) {
    res = sync({ root, mode: 'init', repo: a.repo || env.BASE_REPO || DEFAULT_REPO, tag: a.base, adopt: list(a.adopt), demoPaths: list(a['demo-paths']), includeWorkflows: !!a['include-workflows'], env });
  } else if (a.update) {
    res = sync({ root, mode: 'update', tag: a.to, repo: a.repo, adopt: list(a.adopt), includeWorkflows: !!a['include-workflows'], allowDowngrade: !!a['allow-downgrade'], acceptRemoval: a.acceptRemoval, env });
  } else if (a.release) res = release({ root, version: a.version, env });
  else res = { code: 2, lines: ['usage: base-sync.mjs --init --base=<tag> [--repo=<url>] [--adopt=G1,..] [--demo-paths=a,b] | --check [--remote] | --update [--to=vX.Y.Z] [--allow-downgrade] [--include-workflows] [--accept-removal <path>] | --release --version=vX.Y.Z | --selftest'] };
  for (const l of res.lines) console.log(l);
  return res.code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`base-sync: ${e.message}`); process.exitCode = 1; }
}
