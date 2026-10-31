# demo-kit-base

The shared base for the demo family. Demo repos pull base-owned files from tagged releases of this repo with `scripts/base-sync.mjs`. This is the local v0.1 slice (step B1 of the base design): the sync tool and its tests. The base files themselves, CI and the GitHub repo come in later steps. Nothing here has a remote.

Node 26 or newer, no dependencies, tests use `node:test`.

    npm test

## base-sync

    node scripts/base-sync.mjs --init --base=v0.1.0 [--repo=<url>] [--adopt=G1,G2] [--demo-paths=deploy/,docs]
    node scripts/base-sync.mjs --check [--remote]
    node scripts/base-sync.mjs --update [--to=vX.Y.Z] [--allow-downgrade] [--include-workflows] [--accept-removal <path>] [--adopt=G3]
    node scripts/base-sync.mjs --release --version=vX.Y.Z      # in the base repo
    node scripts/base-sync.mjs --selftest

A demo keeps `demo-kit.lock.json`: base version and commit, the sha256 of every base-owned file at the last sync, seeded hashes, `demoPaths` globs, `overrides` and `adopted` groups. A release carries `base/manifest.json` (`[{path, sha256, group}]`), built by `--release` from `base/groups.json` (`{"groups": {"G1": [globs]}, "seeded": [paths]}`).

Three-hash rule (L = local, B = target base, R = recorded at last sync):

| L vs R | B vs R | Result |
|---|---|---|
| same | same | nothing |
| same | differs | base only: overwrite |
| differs | same | local only: kept, `--check` fails |
| differs | differs, L = B | converged, hash recorded |
| differs | differs, L != B | conflict: `<path>.base-new` written, exit 1, nothing else applied |

Other rules: any file in no manifest row, seeded list, `demoPaths` or `demo/` fails `--check` as `unclassified`; `base/required-deps.json` and `base/required-scripts.json` must be satisfied by the demo's `package.json` files; files of a group not yet in `adopted` are `pending` (reported, not failing); overrides need `path, hash, reason, issue, expires` (at most 30 days out) and fail once expired; a manifest row removed between releases stops `--update` until `--accept-removal`; workflow files are listed, never written, unless `--include-workflows`.

`--update` and `--init` clone the target tag, run the downloaded `scripts/base-sync.mjs --selftest` with only `PATH`, an empty temp `HOME` and `LANG` in its environment (no tokens), and only then apply, all or nothing. A deploy key is used via `BASE_READ_KEY_FILE`. `--release` refuses on a forbidden string (file named by `FORBIDDEN_STRINGS_FILE`), a dirty tree, an existing tag or a failing `server/src/__tests__/baseApi.test.js`.

Path safety: besides rejecting absolute and `..` paths, every write, delete and read of a demo file or the lock is checked by real path. A path is refused (exit 1, message names the path, nothing changed) if its real parent directory leaves the real demo root, if it crosses a symlink loop or dangling symlink, or if it is itself a symlink (base-sync never writes, deletes or reads through a symlinked file, even one pointing inside the root). A symlinked directory whose real target stays inside the demo root is allowed. A malformed lock (bad JSON, a null or mistyped field) is reported as one problem line naming `demo-kit.lock.json` and the field, exit 1. `--update` and `--init` stage all writes and the lock as temp files, rename them in one pass (lock last) and roll back on any failure.

The lock is unsigned in v0.1: a hand-edited lock whose hashes are changed to match edited files passes `--check`, and `--update` accepts it. Treat the lock as reviewed content in the demo repo, not as a trust anchor.

## conformance gate

    node scripts/conformance.mjs [dir] [--tier=Demo|Tester|Tool] [--new] [--json]

Checks a demo repo against `STANDALONE-RULES.md` by files and grep: tier line in the README, `CLAUDE.md`, `ci.yml` with gitleaks and the forbidden-strings gate, a portable shelf entry, `demo-health/1`, content pack, doctor, reset, netguard, ReactFlow without mermaid, `127.0.0.1`-only Docker ports, no EC `generateKeyPair`, and for Demos a talk track, presenter mode, `customer.config`, workspace id and `{{cast}}` stories. Which checks apply depends on the tier (the README's `Tier:` line, or `--tier`); with no tier only the all-tier checks run.

Rules 17 (diagram-studio data) and 18 (k8s manifests and a `MODE` switch) are advisory: they print `WARN` for existing apps and become failures with `--new`, which is how a brand-new app's CI should call it. Exit 1 on any failure, 2 on bad arguments. The check is heuristic: a `FAIL` means an artifact is missing, a `PASS` does not prove the app is good. Add it to a demo's CI as `node scripts/conformance.mjs .` (new apps: `--new`) once base-sync delivers the script.
