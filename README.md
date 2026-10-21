# demo-kit-base

The shared base for the demo family. Demo repos pull base-owned files from tagged releases of this repo with `scripts/base-sync.mjs`. This is the local v0.1 slice (step B1 of the base design): the sync tool and its tests. The base files themselves, CI and the GitHub repo come in later steps. Nothing here has a remote.

Node 20 or newer, no dependencies, tests use `node:test`.

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
