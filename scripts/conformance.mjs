#!/usr/bin/env node
// conformance: file-and-grep check of a demo repo against STANDALONE-RULES.md. Heuristic: a "fail" is a missing artifact, not a proof of
// a bad app, and a "pass" is not a proof of a good one. Node only, no dependencies.
//   node scripts/conformance.mjs [dir] [--tier=Demo|Tester|Tool] [--new] [--json]
// Exit 1 when a required check fails. Checks marked advisory (rules 17 and 19) only fail with --new, so existing apps get warnings; rule 18 is deferred (owner, 2026-10-31) and always warns.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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
  const add = (rule, name, ok, { tiers = 'A', advisory = false, deferred = false, note = '' } = {}) => C.push({ rule, name, ok, tiers, advisory, deferred, note });
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
  // Rule 19 (owner, 2026-11-02): Mock, Real and a toggle that switches. Static evidence only: a POST/PUT .../mode route, /info reporting
  // realAvailable, and a toggle in the UI. It does not start the app; a browser test is the proof. Advisory like rule 17.
  add(19, 'Mock/Real switch: POST /mode route and /info realAvailable', /\.(post|put)\(\s*['"`]\/(api\/)?mode['"`]/.test(srcCode) && /realAvailable/.test(srcCode), { tiers: 'A', advisory: true });
  add(19, 'Mock/Real toggle in the UI (ModeToggle or data-testid mode-real)', /data-testid=["']mode-real["']|\bModeToggle\b/.test(srcCode), { tiers: 'A', advisory: true });
  // Rule 20 (owner, 2026-11-03): shared Ping infrastructure. A standalone must NOT ship its own
  // pingidentity/* container (PF, P1AZ, PingGateway, Privilege Gateway). Evidence of compliance:
  // a pingProducts declaration in docs/shelf-entry.json, or any reference to ping-shared (probe/reuse).
  // PingOne is SaaS and exempt. Advisory: the scan is static and the shared instance is a host property.
  const composeFiles = rel.filter((r) => /compose.*\.ya?ml$|Dockerfile/i.test(r)).map(read).join('\n');
  const shipsPingProduct = /pingidentity\/(pingfederate|pingauthorize|pinggateway|pd-repository)/i.test(composeFiles + allCode);
  const declaresShared = /pingProducts|ping-shared/i.test(rel.filter((r) => /shelf-entry\.json$|\.md$|\.mjs$|\.js$/.test(r)).map(read).join('\n'));
  add(20, 'shared Ping infra: no self-hosted pingidentity/* server container (rule 20)', !shipsPingProduct || declaresShared, { tiers: 'A', advisory: true });
  // Rule 18 (the SE mock-only build) is DEFERRED by the owner (2026-10-31, Docker only): it warns even with --new, so new apps are not forced to ship k8s manifests.
  add(18, 'k8s manifests (k8s/ or deploy/k8s)', has('k8s') || has('deploy/k8s'), { tiers: 'A', advisory: true, deferred: true });
  add(18, 'MODE switch for the mock-only build', /\b(process\.)?env\.(APP_|DEMO_|HOSTED_|MOCKAZ_|P1AZ_)?MODE\b/.test(srcCode), { tiers: 'A', advisory: true, deferred: true });

  // No AI attribution anywhere (owner, 2026-11-07): no Claude Code "Generated with" line or AI Co-Authored-By trailer in any file, and CI runs
  // scripts/check-no-ai-attribution.sh (tree + commits since the rule date). Advisory like rules 17/19 so existing apps warn; --new makes it fail.
  // The pattern is bracketed so this file does not match its own check.
  const CREDIT = /[G]enerated with \[?[C]laude Code|[C]o-[A]uthored-[B]y:[^\r\n]*(Claude|Anthropic|Copilot|GPT|Gemini|Codex|Cursor|opencode)/i;
  const creditFiles = rel.filter((r) => r !== 'scripts/check-no-ai-attribution.sh' && !/package-lock|\.(png|jpe?g|gif|ico|woff2?|zip|pdf)$/i.test(r)).filter((r) => CREDIT.test(read(r)));
  add('attribution', 'no AI-attribution credit in any file (owner rule 2026-11-07)' + (creditFiles.length ? ': ' + creditFiles.slice(0, 3).join(', ') : ''), creditFiles.length === 0, { tiers: 'A', advisory: true });
  add('attribution', 'ci.yml runs scripts/check-no-ai-attribution.sh', /check-no-ai-attribution/.test(ci), { tiers: 'A', advisory: true });

  // Rule 22 (owner, 2026-11-12): the shared TopMenu is vendored byte-identical with a sha256 pin file that is
  // actually verified. Static evidence: web/src/top-menu/{TopMenu.jsx,top-menu.css,top-menu.sha256} exist and the
  // hashes in the pin match the files (a lab that hand-edited the copy fails). A repo test that reads the pin is
  // the enforcement; here we check the pin's content matches.
  const tmDir = path.join(root, 'web/src/top-menu');
  let topMenuOk = false; let topMenuNote = '';
  if (fs.existsSync(path.join(tmDir, 'TopMenu.jsx')) && fs.existsSync(path.join(tmDir, 'top-menu.css')) && fs.existsSync(path.join(tmDir, 'top-menu.sha256'))) {
    try {
      const pins = Object.fromEntries(read('web/src/top-menu/top-menu.sha256').split('\n').filter((l) => l.trim()).map((l) => { const [h, f] = l.trim().split(/\s+/); return [f, h]; }));
      topMenuOk = ['TopMenu.jsx', 'top-menu.css'].every((f) => {
        try { return execSync(`shasum -a 256 '${path.join(tmDir, f)}'`).toString().startsWith(pins[f] || '\u0000'); } catch { return false; }
      });
      if (!topMenuOk) topMenuNote = ' (pin hash mismatch: vendored copy edited, or re-vendored without regenerating the pin)';
    } catch { topMenuNote = ' (could not verify the pin)'; }
  } else topMenuNote = ' (missing web/src/top-menu/{TopMenu.jsx,top-menu.css,top-menu.sha256})';
  add(22, 'shared TopMenu vendored with a matching sha256 pin (rule 22)' + topMenuNote, topMenuOk, { tiers: 'A', advisory: true });

  // Rule 23 (owner, 2026-11-12): downstream failures are named, never blank. Static evidence: the server's upstream
  // call path maps connection-refused/timeout/502-504 to a structured JSON error ({error, message}) — the app names
  // these codes somewhere in non-test source. The proxy 502 down-page itself is shared infrastructure, checked in AI-DEMO-Standalone.
  const errMapOk = /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|502|503|504)/i.test(srcCode) && /error/.test(srcCode);
  add(23, 'upstream failures map to structured JSON errors, never blank (rule 23)', errMapOk, { tiers: 'A', advisory: true });

  const applies = (c) => !t ? c.tiers === 'A' : c.tiers === 'A' || (c.tiers === 'D' && t === 'Demo') || (c.tiers === 'DT' && t !== 'Tool');
  const rows = C.filter(applies).map((c) => ({ ...c, level: c.ok ? 'pass' : (c.deferred || (c.advisory && !strictNew) ? 'warn' : 'fail') }));
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
