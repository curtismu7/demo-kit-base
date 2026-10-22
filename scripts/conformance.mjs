#!/usr/bin/env node
// conformance: file-and-grep check of a demo repo against STANDALONE-RULES.md. Heuristic: a "fail" is a missing artifact, not a proof of
// a bad app, and a "pass" is not a proof of a good one. Node only, no dependencies.
//   node scripts/conformance.mjs [dir] [--tier=Demo|Tester|Tool] [--new] [--json]
// Exit 1 when a required check fails. Checks marked advisory (rules 17, 18) only fail with --new, so existing apps get warnings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.data', 'e2e-output']);
const TIERS = ['Demo', 'Tester', 'Tool'];

function walk(dir, out = [], depth = 0) {
  if (depth > 7) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.(m?js|jsx|ts|tsx|json|md|ya?ml|html)$/.test(e.name)) { try { if (fs.statSync(p).size < 2_000_000) out.push(p); } catch { /* unreadable */ } }
  }
  return out;
}

export function detectTier(readme) { const m = /\*{0,2}Tier:?\*{0,2}:?\s*\*{0,2}(Demo|Tester|Tool)\b/i.exec(readme); return m ? TIERS.find((t) => t.toLowerCase() === m[1].toLowerCase()) : null; }

// Entries of every `ports:` list in a compose file (short syntax), quotes kept.
export function publishedPorts(text) {
  const out = []; let indent = null;
  for (const line of text.split('\n')) {
    const m = /^(\s*)ports:\s*$/.exec(line);
    if (m) { indent = m[1].length; continue; }
    if (indent === null) continue;
    const item = /^(\s*)-\s*(.+?)\s*$/.exec(line);
    if (item && item[1].length >= indent) out.push(item[2]);
    else if (line.trim() && !/^\s*#/.test(line)) indent = null;
  }
  return out;
}

// rule -> which tiers must meet it ('A' all, 'D' demo, 'DT' demo+tester); advisory checks do not fail unless --new
export function audit(root, { tier, strictNew = false } = {}) {
  const abs = (p) => path.join(root, p);
  const has = (p) => fs.existsSync(abs(p));
  const read = (p) => { try { return fs.readFileSync(abs(p), 'utf8'); } catch { return ''; } };
  const all = walk(root);
  const rel = all.map((p) => path.relative(root, p));
  const isTest = (r) => /(^|\/)(test|tests|__tests__)\//.test(r) || /\.test\./.test(r);
  const src = rel.filter((r) => !isTest(r) && !/package-lock/.test(r));
  const srcCode = src.filter((r) => /\.(m?js|jsx|ts|tsx|html)$/.test(r)).map(read).join('\n');
  const allCode = rel.filter((r) => /\.(m?js|jsx|ts|tsx)$/.test(r)).map(read).join('\n');
  const pkgs = ['package.json', 'web/package.json', 'server/package.json'].map(read).join('\n');
  const readme = read('README.md');
  const t = tier || detectTier(readme);
  const ci = read('.github/workflows/ci.yml');
  const compose = ['docker-compose.yml', 'compose.yml'].map(read).join('\n');
  const shelf = (() => { try { return JSON.parse(read('docs/shelf-entry.json')); } catch { return null; } })();
  const unsafePorts = publishedPorts(compose).filter((l) => !/^["']?127\.0\.0\.1:/.test(l));

  const C = [];
  const add = (rule, name, ok, { tiers = 'A', advisory = false, note = '' } = {}) => C.push({ rule, name, ok, tiers, advisory, note });
  add(7, 'tier declared in README (Tier: Demo|Tester|Tool)', !!t);
  add(7, 'CLAUDE.md', has('CLAUDE.md'));
  add(8, 'ci.yml with gitleaks and forbidden-strings', /gitleaks/.test(ci) && /forbidden/i.test(ci));
  add(9, 'docs/shelf-entry.json parses, composeFile is not an absolute path', !!shelf && !/^\/(Users|home)\//.test(String(shelf.composeFile || '')));
  add(15, '/api/health returns demo-health/1', /demo-health\/1/.test(srcCode), { tiers: 'A' });
  add(6, 'content-pack.json', has('content-pack.json'), { tiers: 'DT' });
  add(3, 'doctor script', rel.some((r) => /(^|\/)doctor\.m?js$/.test(r)), { tiers: 'A' });
  add(3, 'reset (script or /api/reset)', rel.some((r) => /reset\.(m?js|sh)$/.test(r)) || /\/api\/reset/.test(srcCode), { tiers: 'DT' });
  add(3, 'talk track', rel.some((r) => /talk-?track/i.test(r)), { tiers: 'D' });
  add(3, 'presenter mode', /presenter/i.test(srcCode), { tiers: 'D' });
  add(1, 'netguard (zero outbound by default)', rel.some((r) => /netguard/i.test(r)), { tiers: 'DT' });
  add(5, 'ReactFlow diagram, no mermaid', /reactflow|@xyflow/i.test(pkgs) && !/mermaid/i.test(pkgs + srcCode), { tiers: 'DT' });
  add(12, 'customer.config', /customer\.config|customerConfig/i.test(srcCode + rel.join('\n')), { tiers: 'D' });
  add(13, 'workspace id', /workspace[-_ ]?id|workspaceId/i.test(srcCode), { tiers: 'D' });
  add(10, 'stories use {{cast}} tokens', /\{\{cast/.test(rel.filter((r) => /\.(json|md)$/.test(r)).map(read).join('\n')) || /\{\{cast/.test(srcCode), { tiers: 'D' });
  add('safety', 'docker publishes 127.0.0.1 only', unsafePorts.length === 0, { tiers: 'A' });
  add('keygen', 'no EC generateKeyPair(Sync) (SIGABRT on Node 20)', !/generateKeyPair(Sync)?\(\s*['"]ec['"]/.test(allCode), { tiers: 'A' });
  add(17, 'diagrams from diagram-studio data', /diagram-studio/i.test(srcCode + pkgs), { tiers: 'DT', advisory: true });
  add(18, 'k8s manifests (k8s/ or deploy/k8s)', has('k8s') || has('deploy/k8s'), { tiers: 'A', advisory: true });
  add(18, 'MODE switch for the mock-only build', /process\.env\.(APP_|DEMO_|HOSTED_)?MODE\b/.test(srcCode), { tiers: 'A', advisory: true });

  const applies = (c) => !t ? c.tiers === 'A' : c.tiers === 'A' || (c.tiers === 'D' && t === 'Demo') || (c.tiers === 'DT' && t !== 'Tool');
  const rows = C.filter(applies).map((c) => ({ ...c, level: c.ok ? 'pass' : (c.advisory && !strictNew ? 'warn' : 'fail') }));
  return { tier: t, rows, failed: rows.filter((r) => r.level === 'fail').length, warned: rows.filter((r) => r.level === 'warn').length };
}

export function main(argv = process.argv.slice(2), out = console.log) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const tier = flag('tier');
  if (tier && !TIERS.includes(tier)) { out(`unknown --tier ${tier}`); return 2; }
  const root = path.resolve(args[0] || '.');
  if (!fs.existsSync(root)) { out(`no such directory: ${root}`); return 2; }
  const res = audit(root, { tier, strictNew: argv.includes('--new') });
  if (argv.includes('--json')) out(JSON.stringify(res, null, 2));
  else {
    out(`conformance: ${path.basename(root)} (tier ${res.tier || 'undeclared: only all-tier rules checked'})`);
    for (const r of res.rows) out(`${r.level.toUpperCase().padEnd(5)} rule ${String(r.rule).padEnd(6)} ${r.name}`);
    out(`${res.failed} failed, ${res.warned} advisory warning(s)`);
  }
  return res.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main());
