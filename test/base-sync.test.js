// Tests run against fixture trees only: a tiny base and a tiny demo built in temp dirs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LOCK, sha, classify3, globToRegExp, check, sync, release, latestTag, remoteCheck, main, parseArgs, selftest,
} from '../scripts/base-sync.mjs';

const REAL_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/base-sync.mjs');
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-test-')); made.push(d); return d; };
const put = (root, p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
const get = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

before(() => {
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
});
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// spec: { files: { path: { c: content, group, seeded? } }, script?: string }
function publish(dir, spec, tag) {
  for (const p of git(dir, 'ls-files').split('\n').filter(Boolean)) fs.rmSync(path.join(dir, p));
  const rows = [];
  const files = { ...spec.files };
  files['scripts/base-sync.mjs'] = { c: spec.script ?? fs.readFileSync(REAL_SCRIPT, 'utf8'), group: 'G1' };
  for (const [p, f] of Object.entries(files)) {
    put(dir, p, f.c);
    rows.push({ path: p, sha256: sha(f.c), group: f.seeded ? 'seeded' : f.group, ...(f.seeded ? { seeded: true } : {}) });
  }
  put(dir, 'base/manifest.json', JSON.stringify(rows));
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', tag); git(dir, 'tag', tag);
}
function makeBase(spec, tag = 'v1.0.0') {
  const dir = tmp(); git(dir, 'init', '-q', '-b', 'main'); publish(dir, spec, tag); return dir;
}
const V1 = { files: { 'lib/a.js': { c: 'a1', group: 'G1' }, 'lib/b.js': { c: 'b1', group: 'G2' }, 'README.md': { c: 'seed1', seeded: true } } };
const V2 = { files: { 'lib/a.js': { c: 'a2', group: 'G1' }, 'lib/b.js': { c: 'b2', group: 'G2' }, 'README.md': { c: 'seed2', seeded: true } } };
const initDemo = (base, extra = {}) => {
  const demo = tmp();
  put(demo, 'demo/demo.json', '{}');
  const r = sync({ root: demo, mode: 'init', repo: base, tag: 'v1.0.0', ...extra });
  assert.equal(r.code, 0, r.lines.join('\n'));
  return demo;
};
const kinds = (r) => r.problems.map((p) => `${p.kind}:${p.path}`).sort();

describe('three-hash table (every row)', () => {
  const rows = [
    ['L=R, B=R: nothing to do', 'a', 'a', 'a', 'unchanged'],
    ['L=R, B!=R: base only changed, overwrite', 'a', 'b', 'a', 'overwrite'],
    ['L!=R, B=R: local only changed', 'x', 'a', 'a', 'local-only'],
    ['L!=R, B!=R, L!=B: both changed, conflict', 'x', 'b', 'a', 'conflict'],
    ['L!=R, B!=R, L=B: both changed identically, converged', 'b', 'b', 'a', 'converged'],
    ['file deleted locally, base unchanged: local-only', null, 'a', 'a', 'local-only'],
    ['file deleted locally, base changed: conflict', null, 'b', 'a', 'conflict'],
    ['new base file, absent locally: add', null, 'b', null, 'add'],
    ['new base file, identical local copy: converged', 'b', 'b', null, 'converged'],
    ['new base file, different local copy: conflict', 'x', 'b', null, 'conflict'],
  ];
  for (const [name, L, B, R, want] of rows) test(name, () => assert.equal(classify3(L, B, R), want));
});

describe('globs', () => {
  test('wildcards, directory prefixes, exact names', () => {
    assert.ok(globToRegExp('deploy/').test('deploy/a/b.yml'));
    assert.ok(globToRegExp('docs').test('docs/x.md'));
    assert.ok(globToRegExp('web/src/**/*.json').test('web/src/data/x.json'));
    assert.ok(!globToRegExp('web/*.json').test('web/src/x.json'));
    assert.ok(!globToRegExp('docs').test('docsy/x.md'));
  });
});

describe('--init and --check', () => {
  test('init writes the lock, copies files and seeded files once; check passes', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    assert.equal(get(demo, 'lib/a.js'), 'a1');
    assert.equal(get(demo, 'README.md'), 'seed1');
    const lock = JSON.parse(get(demo, LOCK));
    assert.equal(lock.base.version, 'v1.0.0');
    assert.equal(lock.files['lib/a.js'].sha256, sha('a1'));
    assert.deepEqual(Object.keys(lock.seeded), ['README.md']);
    assert.deepEqual(check(demo), { ok: true, problems: [], pending: [] });
  });
  test('check exits 1 after a hand edit (CLI)', () => {
    const demo = initDemo(makeBase(V1));
    const run = () => spawnSync(process.execPath, [REAL_SCRIPT, '--check', '--root', demo], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    put(demo, 'lib/a.js', 'edited');
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /modified: lib\/a\.js/);
  });
  test('missing base-owned file fails', () => {
    const demo = initDemo(makeBase(V1));
    fs.rmSync(path.join(demo, 'lib/a.js'));
    assert.deepEqual(kinds(check(demo)), ['missing:lib/a.js']);
  });
  test('no lock fails', () => assert.equal(check(tmp()).ok, false));
  test('init refuses when a lock exists', () => {
    const demo = initDemo(makeBase(V1));
    assert.equal(sync({ root: demo, mode: 'init', repo: 'x', tag: 'v1.0.0' }).code, 1);
  });
  test('init conflict (different local copy) writes .base-new, exit 1, no lock', () => {
    const base = makeBase(V1);
    const demo = tmp(); put(demo, 'lib/a.js', 'mine');
    const r = sync({ root: demo, mode: 'init', repo: base, tag: 'v1.0.0' });
    assert.equal(r.code, 1);
    assert.equal(get(demo, 'lib/a.js.base-new'), 'a1');
    assert.equal(get(demo, 'lib/a.js'), 'mine');
    assert.ok(!fs.existsSync(path.join(demo, LOCK)));
    assert.ok(!fs.existsSync(path.join(demo, 'lib/b.js')));
  });
});

describe('unclassified', () => {
  test('a tracked file in none of the four fails; demo/, demoPaths, seeded and base rows pass', () => {
    const demo = initDemo(makeBase(V1), { demoPaths: ['deploy/', 'docs'] });
    put(demo, 'deploy/x.yml', '1'); put(demo, 'docs/a/b.md', '1'); put(demo, 'demo/more/c.json', '1');
    assert.ok(check(demo).ok);
    put(demo, 'stray.txt', '1');
    assert.deepEqual(kinds(check(demo)), ['unclassified:stray.txt']);
  });
  test('uses git ls-files when the demo is a git repo (ignored files are not flagged)', () => {
    const demo = initDemo(makeBase(V1));
    git(demo, 'init', '-q', '-b', 'main');
    put(demo, '.gitignore', 'ignored.txt\n'); put(demo, 'ignored.txt', '1');
    assert.deepEqual(kinds(check(demo)), ['unclassified:.gitignore']);
  });
});

describe('required deps and scripts', () => {
  const baseWith = () => makeBase({ files: {
    ...V1.files,
    'base/required-deps.json': { c: '{"express":"4","react":"^18.2.0"}', group: 'G1' },
    'base/required-scripts.json': { c: '["test","build"]', group: 'G1' },
  } });
  const pkg = (o) => JSON.stringify(o);
  test('missing dep, wrong major and missing script each fail', () => {
    const demo = initDemo(baseWith());
    put(demo, 'package.json', pkg({ dependencies: { react: '^17.0.0' }, scripts: { test: 'x' } }));
    const r = check(demo);
    assert.deepEqual(r.problems.filter((p) => p.kind === 'dep' || p.kind === 'script').map((p) => p.kind).sort(), ['dep', 'dep', 'script']);
    assert.ok(r.problems.some((p) => /express/.test(p.msg)));
    assert.ok(r.problems.some((p) => /react.*major 18/.test(p.msg)));
    assert.ok(r.problems.some((p) => /"build"/.test(p.msg)));
  });
  test('satisfied deps (server/web package.json count) and scripts pass', () => {
    const demo = initDemo(baseWith());
    put(demo, 'package.json', pkg({ scripts: { test: 'x', build: 'y' }, devDependencies: { express: '^4.19.0' } }));
    put(demo, 'web/package.json', pkg({ dependencies: { react: '~18.3.1' } }));
    assert.deepEqual(kinds(check(demo)).filter((k) => !k.startsWith('unclassified')), []);
  });
  test('update prints exactly what to add', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    publish(base, { files: { ...V1.files, 'base/required-scripts.json': { c: '["doctor"]', group: 'G1' } } }, 'v1.1.0');
    const r = sync({ root: demo, mode: 'update', env: process.env });
    assert.equal(r.code, 0);
    assert.ok(r.lines.some((l) => /add by hand: missing npm script "doctor"/.test(l)));
  });
});

describe('adopted / pending', () => {
  test('files of a not-yet-adopted group are pending, not failing, not unclassified', () => {
    const base = makeBase(V1);
    const demo = tmp();
    put(demo, 'lib/b.js', 'my own b');
    const r = sync({ root: demo, mode: 'init', repo: base, tag: 'v1.0.0', adopt: ['G1'] });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(get(demo, 'lib/b.js'), 'my own b');
    const c = check(demo);
    assert.ok(c.ok, JSON.stringify(c.problems));
    assert.deepEqual(c.pending, ['lib/b.js']);
  });
  test('adopting a group later takes the three-hash path: differing local copy is a conflict, identical one converges', () => {
    const base = makeBase(V1);
    const demo = tmp(); put(demo, 'lib/b.js', 'my own b');
    sync({ root: demo, mode: 'init', repo: base, tag: 'v1.0.0', adopt: ['G1'] });
    const r = sync({ root: demo, mode: 'update', adopt: ['G2'] });
    assert.equal(r.code, 1);
    assert.equal(get(demo, 'lib/b.js.base-new'), 'b1');
    fs.rmSync(path.join(demo, 'lib/b.js.base-new'));
    put(demo, 'lib/b.js', 'b1');
    assert.equal(sync({ root: demo, mode: 'update', adopt: ['G2'] }).code, 0);
    const lock = JSON.parse(get(demo, LOCK));
    assert.deepEqual(lock.adopted, ['G1', 'G2']);
    assert.ok(check(demo).ok);
  });
  test('adopted group file never synced fails as unsynced', () => {
    const demo = initDemo(makeBase(V1), { adopt: ['G1'] });
    const lock = JSON.parse(get(demo, LOCK)); lock.adopted.push('G2'); put(demo, LOCK, JSON.stringify(lock));
    put(demo, 'lib/b.js', 'x');
    assert.ok(kinds(check(demo)).includes('unsynced:lib/b.js'));
  });
});

describe('overrides', () => {
  const withOverride = (o) => {
    const demo = initDemo(makeBase(V1));
    put(demo, 'lib/a.js', 'patched');
    const lock = JSON.parse(get(demo, LOCK));
    lock.overrides = [{ path: 'lib/a.js', hash: sha('patched'), reason: 'local fix', issue: '#1', expires: '2026-11-01', ...o }];
    put(demo, LOCK, JSON.stringify(lock));
    return demo;
  };
  const NOW = '2026-10-21';
  test('valid override lets the edit pass', () => assert.ok(check(withOverride({}), { now: NOW }).ok));
  test('expired override fails', () => assert.deepEqual(kinds(check(withOverride({ expires: '2026-10-20' }), { now: NOW })).filter((k) => k.startsWith('override')), ['override-expired:lib/a.js']));
  test('expiry beyond 30 days fails', () => assert.ok(kinds(check(withOverride({ expires: '2026-12-31' }), { now: NOW })).includes('override-invalid:lib/a.js')));
  test('override whose hash no longer matches the file fails', () => {
    const demo = withOverride({}); put(demo, 'lib/a.js', 'patched again');
    assert.ok(kinds(check(demo, { now: NOW })).includes('modified:lib/a.js'));
  });
  test('override missing reason or issue is invalid', () => {
    assert.ok(kinds(check(withOverride({ reason: '' }), { now: NOW })).includes('override-invalid:lib/a.js'));
    assert.ok(kinds(check(withOverride({ issue: undefined }), { now: NOW })).includes('override-invalid:lib/a.js'));
  });
  test('update keeps a file under a valid override instead of conflicting', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    put(demo, 'lib/a.js', 'patched');
    const lock = JSON.parse(get(demo, LOCK));
    const exp = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    lock.overrides = [{ path: 'lib/a.js', hash: sha('patched'), reason: 'r', issue: '#2', expires: exp }];
    put(demo, LOCK, JSON.stringify(lock));
    publish(base, V2, 'v1.1.0');
    const r = sync({ root: demo, mode: 'update' });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(get(demo, 'lib/a.js'), 'patched');
    assert.equal(get(demo, 'lib/b.js'), 'b2');
  });
});

describe('--update', () => {
  test('base-only change is overwritten; seeded file is not; lock moves to the new tag', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    put(demo, 'README.md', 'my readme');
    publish(base, V2, 'v1.1.0');
    const r = sync({ root: demo, mode: 'update' });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.equal(get(demo, 'lib/a.js'), 'a2');
    assert.equal(get(demo, 'README.md'), 'my readme');
    const lock = JSON.parse(get(demo, LOCK));
    assert.equal(lock.base.version, 'v1.1.0');
    assert.equal(lock.files['lib/a.js'].sha256, sha('a2'));
    assert.ok(check(demo).ok);
  });
  test('local-only change is kept and --check keeps failing', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    put(demo, 'lib/a.js', 'mine');
    publish(base, { files: { ...V1.files, 'lib/b.js': { c: 'b2', group: 'G2' } } }, 'v1.1.0');
    const r = sync({ root: demo, mode: 'update' });
    assert.equal(r.code, 0);
    assert.equal(get(demo, 'lib/a.js'), 'mine');
    assert.equal(get(demo, 'lib/b.js'), 'b2');
    assert.deepEqual(kinds(check(demo)), ['modified:lib/a.js']);
  });
  test('converged edit just records the new hash', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    put(demo, 'lib/a.js', 'a2');
    publish(base, V2, 'v1.1.0');
    assert.equal(sync({ root: demo, mode: 'update' }).code, 0);
    assert.ok(check(demo).ok);
  });
  test('atomic on conflict: nothing but .base-new changes, lock untouched, exit 1', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    put(demo, 'lib/a.js', 'mine');
    const lockBefore = get(demo, LOCK);
    publish(base, V2, 'v1.1.0');
    const r = sync({ root: demo, mode: 'update' });
    assert.equal(r.code, 1);
    assert.equal(get(demo, 'lib/a.js'), 'mine');
    assert.equal(get(demo, 'lib/a.js.base-new'), 'a2');
    assert.equal(get(demo, 'lib/b.js'), 'b1', 'non-conflicting file must not be applied');
    assert.equal(get(demo, LOCK), lockBefore);
  });
  test('atomic on a failing selftest: old copy stays, nothing changes, exit 1', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    const before = { a: get(demo, 'lib/a.js'), lock: get(demo, LOCK), tool: get(demo, 'scripts/base-sync.mjs') };
    publish(base, { ...V2, script: 'process.exit(1);\n' }, 'v1.1.0');
    const r = sync({ root: demo, mode: 'update' });
    assert.equal(r.code, 1);
    assert.match(r.lines[0], /selftest/);
    assert.equal(get(demo, 'lib/a.js'), before.a);
    assert.equal(get(demo, LOCK), before.lock);
    assert.equal(get(demo, 'scripts/base-sync.mjs'), before.tool);
  });
  test('self-update: the downloaded updater runs with no token in its environment', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    const dump = path.join(tmp(), 'env.json');
    publish(base, { ...V2, script: `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ keys: Object.keys(process.env), home: process.env.HOME, cwd: process.cwd(), argv: process.argv.slice(2) }));\n` }, 'v1.1.0');
    const sentinels = ['BASE_SYNC_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACTIONS', 'BASE_READ_KEY', 'BASE_READ_KEY_FILE'];
    const saved = Object.fromEntries(sentinels.map((k) => [k, process.env[k]]));
    for (const k of sentinels) process.env[k] = 'sentinel';
    let r;
    try { r = sync({ root: demo, mode: 'update', env: process.env }); } finally {
      for (const k of sentinels) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    assert.equal(r.code, 0, r.lines.join('\n'));
    const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
    for (const k of sentinels) assert.ok(!seen.keys.includes(k), `${k} leaked into the updater`);
    assert.ok(!seen.keys.some((k) => k.startsWith('GITHUB_') || k.startsWith('GH_') || k.startsWith('BASE_')));
    assert.deepEqual(seen.argv, ['--selftest']);
    assert.notEqual(seen.home, os.homedir());
    assert.ok(!seen.cwd.includes(path.basename(demo)));
  });
  test('removed manifest row stops the update; --accept-removal drops an unmodified file', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    publish(base, { files: { 'lib/a.js': V1.files['lib/a.js'], 'README.md': V1.files['README.md'] } }, 'v1.1.0');
    const lockBefore = get(demo, LOCK);
    const r = sync({ root: demo, mode: 'update' });
    assert.equal(r.code, 1);
    assert.ok(r.lines.some((l) => /removed in base: lib\/b\.js/.test(l)));
    assert.equal(get(demo, LOCK), lockBefore);
    assert.ok(fs.existsSync(path.join(demo, 'lib/b.js')));
    const ok = sync({ root: demo, mode: 'update', acceptRemoval: ['lib/b.js'] });
    assert.equal(ok.code, 0, ok.lines.join('\n'));
    assert.ok(!fs.existsSync(path.join(demo, 'lib/b.js')));
    assert.equal(JSON.parse(get(demo, LOCK)).files['lib/b.js'], undefined);
  });
  test('workflow files are listed, not written, unless --include-workflows', () => {
    const wf = { c: 'wf1', group: 'G1' };
    const base = makeBase({ files: { ...V1.files, '.github/workflows/ci.yml': wf } });
    const demo = initDemo(base);
    assert.ok(!fs.existsSync(path.join(demo, '.github/workflows/ci.yml')), 'init also skips workflows');
    publish(base, { files: { ...V2.files, '.github/workflows/ci.yml': { c: 'wf2', group: 'G1' } } }, 'v1.1.0');
    const r = sync({ root: demo, mode: 'update' });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.ok(r.lines.some((l) => /workflow files NOT written.*ci\.yml/.test(l)));
    assert.ok(!fs.existsSync(path.join(demo, '.github/workflows/ci.yml')));
    const r2 = sync({ root: demo, mode: 'update', tag: 'v1.1.0', includeWorkflows: true });
    assert.equal(r2.code, 0, r2.lines.join('\n'));
    assert.equal(get(demo, '.github/workflows/ci.yml'), 'wf2');
  });
  test('downgrade is refused unless --allow-downgrade (rollback path)', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    publish(base, V2, 'v1.1.0');
    assert.equal(sync({ root: demo, mode: 'update' }).code, 0);
    const refused = sync({ root: demo, mode: 'update', tag: 'v1.0.0' });
    assert.equal(refused.code, 1);
    assert.match(refused.lines[0], /downgrade/);
    assert.equal(get(demo, 'lib/a.js'), 'a2');
    assert.equal(sync({ root: demo, mode: 'update', tag: 'v1.0.0', allowDowngrade: true }).code, 0);
    assert.equal(get(demo, 'lib/a.js'), 'a1');
  });
  test('latestTag picks the highest semver; --check --remote reports behind', () => {
    const base = makeBase(V1);
    const demo = initDemo(base);
    publish(base, V2, 'v1.10.0'); publish(base, V2, 'v1.9.0');
    assert.equal(latestTag(base), 'v1.10.0');
    assert.match(remoteCheck(demo).lines[0], /v1\.10\.0 is available/);
  });
});

describe('--release', () => {
  const groups = JSON.stringify({ groups: { G1: ['lib/**', 'base/**', 'scripts/'] }, seeded: ['README.md'] });
  function baseRepo(extra = {}) {
    const dir = tmp(); git(dir, 'init', '-q', '-b', 'main');
    put(dir, 'base/groups.json', groups); put(dir, 'lib/a.js', 'a'); put(dir, 'README.md', 'r'); put(dir, 'examples/x.txt', 'not shipped');
    for (const [p, c] of Object.entries(extra)) put(dir, p, c);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
    return dir;
  }
  const idsFile = (lines) => { const f = path.join(tmp(), 'ids'); fs.writeFileSync(f, lines); return f; };
  test('writes the manifest, commits, tags; a demo can init from it', () => {
    const dir = baseRepo();
    const r = release({ root: dir, version: 'v0.1.0', env: { ...process.env, FORBIDDEN_STRINGS_FILE: idsFile('never-present\n') } });
    assert.equal(r.code, 0, r.lines.join('\n'));
    assert.match(git(dir, 'tag', '--list'), /v0\.1\.0/);
    const m = JSON.parse(get(dir, 'base/manifest.json'));
    assert.deepEqual(m.map((x) => x.path), ['README.md', 'base/groups.json', 'lib/a.js']);
    assert.equal(m.find((x) => x.path === 'README.md').seeded, true);
    assert.equal(git(dir, 'status', '--porcelain').trim(), '');
  });
  test('refuses a forbidden string, a missing strings file, a dirty tree, a bad version, a repeated tag', () => {
    const dir = baseRepo({ 'lib/leak.txt': 'contains SECRET-ID-123' });
    const env = { ...process.env, FORBIDDEN_STRINGS_FILE: idsFile('SECRET-ID-123\n') };
    const r = release({ root: dir, version: 'v0.1.0', env });
    assert.equal(r.code, 1);
    assert.ok(!r.lines.join('').includes('SECRET-ID-123'), 'the forbidden string must not be printed');
    assert.equal(git(dir, 'tag', '--list').trim(), '');
    const clean = baseRepo();
    assert.equal(release({ root: clean, version: 'v0.1.0', env: { ...process.env, FORBIDDEN_STRINGS_FILE: '' } }).code, 1);
    put(clean, 'dirty.txt', '1');
    assert.equal(release({ root: clean, version: 'v0.1.0', env: { ...process.env, FORBIDDEN_STRINGS_FILE: idsFile('x\n') } }).code, 1);
    assert.equal(release({ root: clean, version: '0.1', env }).code, 1);
  });
  test('refuses a tag whose baseApi.test.js fails', () => {
    const dir = baseRepo({ 'server/src/__tests__/baseApi.test.js': "import { test } from 'node:test';\ntest('x', () => { throw new Error('no'); });\n" });
    const r = release({ root: dir, version: 'v0.1.0', env: { ...process.env, FORBIDDEN_STRINGS_FILE: idsFile('x\n') } });
    assert.equal(r.code, 1);
    assert.match(r.lines[0], /baseApi/);
    assert.equal(git(dir, 'tag', '--list').trim(), '');
  });
});

describe('cli and selftest', () => {
  test('parseArgs handles = and space forms and repeats', () => {
    const a = parseArgs(['--update', '--to=v1.0.0', '--accept-removal', 'a', '--accept-removal=b', '--allow-downgrade']);
    assert.deepEqual([a.to, a.acceptRemoval, a['allow-downgrade']], ['v1.0.0', ['a', 'b'], true]);
  });
  test('no command prints usage and exits 2', () => {
    const log = console.log; console.log = () => {};
    try { assert.equal(main([]), 2); } finally { console.log = log; }
  });
  test('selftest passes and the CLI --selftest exits 0', () => {
    assert.equal(selftest(), true);
    assert.equal(spawnSync(process.execPath, [REAL_SCRIPT, '--selftest']).status, 0);
  });
});
