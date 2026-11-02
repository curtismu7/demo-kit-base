import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, detectTier, publishedPorts, main } from '../scripts/conformance.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-')); made.push(d); return d; };
const put = (root, p, c = 'x') => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const CI = 'jobs:\n  secrets:\n    steps:\n      - run: gitleaks detect\n      - name: forbidden strings (history)\n        run: echo\n';
function compliantTester(root) {
  put(root, 'README.md', '# x\n\n**Tier: Tester**\n');
  put(root, 'CLAUDE.md'); put(root, '.github/workflows/ci.yml', CI);
  put(root, 'docs/shelf-entry.json', JSON.stringify({ composeFile: 'docker-compose.yml' }));
  put(root, 'content-pack.json', '{}'); put(root, 'scripts/doctor.mjs'); put(root, 'scripts/reset.mjs');
  put(root, 'server/src/netguard.js'); put(root, 'server/src/health.js', "schema: 'demo-health/1'");
  put(root, 'package.json', '{"dependencies":{"@xyflow/react":"1"}}');
  put(root, 'server/src/mode.js', "api.post('/mode', h); const info = { source, realAvailable };"); put(root, 'web/src/ModeToggle.jsx', 'export default function ModeToggle() {}');
  put(root, 'docker-compose.yml', 'services:\n  app:\n    ports:\n      - "127.0.0.1:4901:4901"\n');
}
const rule = (res, name) => res.rows.find((r) => r.name.includes(name));

test('tier is read from the README in the common spellings', () => {
  assert.equal(detectTier('**Tier: Tester**'), 'Tester');
  assert.equal(detectTier('Tier: demo'), 'Demo');
  assert.equal(detectTier('**Tier:** Tool'), 'Tool');
  assert.equal(detectTier('no tier here'), null);
});

test('a compliant Tester passes every required check; rules 17 and 18 only warn', () => {
  const d = tmp(); compliantTester(d);
  const r = audit(d);
  assert.equal(r.tier, 'Tester'); assert.equal(r.failed, 0, JSON.stringify(r.rows.filter((x) => x.level === 'fail')));
  assert.equal(rule(r, 'k8s').level, 'warn'); assert.equal(rule(r, 'diagram-studio').level, 'warn');
  assert.equal(rule(r, 'talk track'), undefined, 'talk track is Demo-only');
});

test('--new turns the advisory rule 17 into a failure; the deferred rule 18 still only warns', () => {
  const d = tmp(); compliantTester(d);
  const r = audit(d, { strictNew: true });
  assert.equal(rule(r, 'diagram-studio').level, 'fail');
  assert.equal(rule(r, 'k8s').level, 'warn', 'rule 18 is deferred (owner, 2026-10-31): never a failure');
  assert.equal(rule(r, 'MODE').level, 'warn', 'rule 18 is deferred (owner, 2026-10-31): never a failure');
  assert.equal(r.failed, 1);
  put(d, 'web/src/d.js', "import 'diagram-studio'");
  assert.equal(audit(d, { strictNew: true }).failed, 0);
  put(d, 'k8s/deployment.yaml'); put(d, 'server/src/mode.js', 'export const m = process.env.MODE;');
  const ok = audit(d, { strictNew: true });
  assert.equal(rule(ok, 'k8s').level, 'pass'); assert.equal(rule(ok, 'MODE').level, 'pass');
});

test('a Demo also needs talk track, presenter mode, customer.config, workspace id and cast tokens', () => {
  const d = tmp(); compliantTester(d); put(d, 'README.md', 'Tier: Demo');
  const names = audit(d).rows.filter((r) => r.level === 'fail').map((r) => r.rule).sort();
  assert.deepEqual(names.map(String), ['10', '12', '13', '3', '3'].sort());
  put(d, 'docs/talk-track.md'); put(d, 'web/src/p.js', 'presenter'); put(d, 'server/src/c.js', 'customer.config workspaceId {{cast.user}}');
  assert.equal(audit(d).failed, 0);
});

test('a Tool is exempt from the demo-only rules (no content pack, reset, netguard, diagram)', () => {
  const d = tmp(); compliantTester(d); put(d, 'README.md', 'Tier: Tool'); fs.rmSync(path.join(d, 'content-pack.json')); fs.rmSync(path.join(d, 'scripts/reset.mjs')); fs.rmSync(path.join(d, 'server/src/netguard.js'));
  assert.equal(audit(d).failed, 0);
});

test('missing CLAUDE.md, tier and CI gates are reported', () => {
  const d = tmp(); put(d, 'README.md', '# no tier');
  const r = audit(d);
  assert.equal(r.tier, null);
  for (const n of ['tier declared', 'CLAUDE.md', 'ci.yml', 'shelf-entry', 'demo-health']) assert.equal(rule(r, n).level, 'fail', n);
});

test('a CI file without the forbidden-strings gate fails rule 8; an absolute composeFile fails rule 9', () => {
  const d = tmp(); compliantTester(d);
  put(d, '.github/workflows/ci.yml', 'steps:\n  - run: gitleaks detect\n');
  put(d, 'docs/shelf-entry.json', JSON.stringify({ composeFile: '/Users/someone/x/docker-compose.yml' }));
  const r = audit(d);
  assert.equal(rule(r, 'ci.yml').level, 'fail'); assert.equal(rule(r, 'shelf-entry').level, 'fail');
});

test('docker ports must publish on 127.0.0.1; a bare or 0.0.0.0 mapping fails', () => {
  assert.deepEqual(publishedPorts('services:\n  a:\n    ports:\n      - "127.0.0.1:1:1"\n      - 8080:80\n    volumes:\n      - ./a:/b\n'), ['"127.0.0.1:1:1"', '8080:80']);
  const d = tmp(); compliantTester(d);
  put(d, 'docker-compose.yml', 'services:\n  a:\n    ports:\n      - "4901:4901"\n');
  assert.equal(rule(audit(d), 'docker publishes').level, 'fail');
  put(d, 'docker-compose.yml', 'services:\n  a:\n    ports:\n      - "0.0.0.0:4901:4901"\n');
  assert.equal(rule(audit(d), 'docker publishes').level, 'fail');
});

test('EC generateKeyPair is flagged, RSA is not, mermaid fails the diagram rule', () => {
  const d = tmp(); compliantTester(d);
  put(d, 'server/src/k.js', "crypto.generateKeyPairSync('rsa', {})");
  assert.equal(rule(audit(d), 'EC generateKeyPair').level, 'pass');
  put(d, 'server/test/k.test.js', "crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })");
  assert.equal(rule(audit(d), 'EC generateKeyPair').level, 'fail');
  put(d, 'web/src/m.js', "import mermaid from 'mermaid'");
  assert.equal(rule(audit(d), 'ReactFlow').level, 'fail');
});

test('node_modules and symlinks are not scanned', () => {
  const d = tmp(); compliantTester(d);
  put(d, 'node_modules/x/index.js', "generateKeyPairSync('ec')");
  assert.equal(rule(audit(d), 'EC generateKeyPair').level, 'pass');
});

test('main: exit 0 for a compliant app, 1 for failures, 2 for bad arguments; --json is parseable', () => {
  const d = tmp(); compliantTester(d); const lines = [];
  assert.equal(main([d], (l) => lines.push(l)), 0);
  assert.equal(main([d, '--new'], () => {}), 1);
  assert.equal(main([d, '--tier=Nope'], () => {}), 2);
  assert.equal(main([path.join(d, 'missing')], () => {}), 2);
  const j = []; main([d, '--json'], (l) => j.push(l)); assert.equal(JSON.parse(j.join('')).failed, 0);
});

test('rule 19: Mock/Real switch and toggle are advisory; they warn on an existing app and fail with --new', () => {
  const d = tmp(); compliantTester(d);
  fs.rmSync(path.join(d, 'server/src/mode.js')); fs.rmSync(path.join(d, 'web/src/ModeToggle.jsx'));
  const r = audit(d);
  assert.equal(rule(r, 'Mock/Real switch').level, 'warn'); assert.equal(rule(r, 'Mock/Real toggle').level, 'warn');
  const strict = audit(d, { strictNew: true });
  assert.equal(rule(strict, 'Mock/Real switch').level, 'fail'); assert.equal(rule(strict, 'Mock/Real toggle').level, 'fail');
  put(d, 'server/src/mode.js', "api.post('/mode', h); const info = { source, realAvailable };");
  assert.equal(rule(audit(d, { strictNew: true }), 'Mock/Real switch').level, 'pass');
  assert.equal(rule(audit(d, { strictNew: true }), 'Mock/Real toggle').level, 'fail', 'a route alone is not a toggle');
  put(d, 'web/src/ModeToggle.jsx', 'export default function ModeToggle() {}');
  assert.equal(audit(d, { strictNew: true }).failed, 1, 'only rule 17 (diagram-studio) is left');
});

test('rule 19: a route that only reads /mode, or a /mode route with no realAvailable, is not a switch; test files do not count', () => {
  const d = tmp(); compliantTester(d);
  fs.rmSync(path.join(d, 'server/src/mode.js'));
  put(d, 'server/src/mode.js', "app.get('/mode', h); const info = { source, realAvailable };");
  assert.equal(rule(audit(d), 'Mock/Real switch').level, 'warn');
  put(d, 'server/src/mode.js', "api.post('/mode', h);");
  assert.equal(rule(audit(d), 'Mock/Real switch').level, 'warn');
  fs.rmSync(path.join(d, 'server/src/mode.js'));
  put(d, 'server/test/mode.test.js', "api.post('/mode', h); realAvailable");
  assert.equal(rule(audit(d), 'Mock/Real switch').level, 'warn');
});
