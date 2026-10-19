# Fidus X — release discipline

Every production surface must be traceable to one reviewed, pushed, tagged Git
commit. Until 2026-10-19 none was. This document is the rule and the procedure.

## Why this exists — the 2026-10-19 release forensics

| Surface | What was actually live | Reproducible from Git? |
|---|---|---|
| Customer hosting (`lamax-4fd82`) | Working tree as of 2026-10-10 (uncommitted changes on `a02fab8`) | No |
| Artisan hosting (`lamax-artisan`) | Working-tree snapshot of 2026-09-03 | No (mostly = HEAD; some files match no commit) |
| Admin hosting (`lamax-admin`) | Working-tree snapshot of 2026-09-03 | No |
| Cloud Functions (54) | **Ten** different source snapshots uploaded 2026-08-13 → 2026-09-09 | 6 functions yes, 48 no |
| Firestore rules | Ruleset of 2026-08-28; content = `a02fab8` | Yes |
| Storage rules | Ruleset of 2026-08-17; content = `a02fab8` | Yes |
| Android | Debug APK of 2026-09-09 01:13 (versionCode 1), from the working tree | No |

Three things caused it:

1. **Deploys ship whatever is on disk.** `scripts/stage-hosting.cjs` copies the
   working tree; `firebase deploy --only functions` uploads `functions/` as is.
2. **Partial function deploys.** `--only functions:a,b` updates only those
   functions; every other function keeps the code from its own last deploy.
   Each function runs its own complete copy of every module, so two functions
   can disagree about shared logic.
3. **Nothing recorded provenance**, and 14 commits were never pushed, so the
   only copy of the source was one OneDrive folder.

Note: a function's "last updated" time in the console is **not** its deploy
time. Automatic base-image updates (`automaticUpdatePolicy`) bump it — every
function showed 2026-10-18 for source uploaded in August/September.

## The rule

A production release is deployed only from a **clean checkout of a pushed tag**,
to an **explicitly named project**, and **every surface** (all hosting targets,
all functions, both rulesets) comes from that same tag.

`npm run release:check -- --project <alias>` enforces the first three. It
refuses when the tree is dirty, HEAD is on no remote branch, HEAD is untagged,
no project is named, or the project is not `lamax-4fd82` / `lamax-staging`.

## Procedure

1. **Freeze.** No deploys while preparing the candidate.
2. **Commit the work in reviewed, separate commits.** Never commit generated
   output, logs, IDE files or secrets with them (see *Hygiene*).
3. **Push**, so the source exists outside this machine.
4. **Run the full suite** on the candidate:
   `npm test`, `npm run test:rules`, `npm run test:privacy-rules`,
   `npm run lint:shared`.
5. **Tag**: `git tag release-YYYY-MM-DD.N` and push the tag.
6. **Clean checkout of the tag** into a fresh, SHORT directory outside OneDrive:
   `git -c core.longpaths=true clone --branch release-YYYY-MM-DD.N <repo> C:\fxr`,
   then `git config core.longpaths true` inside it, `npm ci` at the root and in
   `functions/`, and restore `functions/.env` from the secret store (it is not
   in Git). Without long paths a Windows checkout FAILS: the tracked
   `.claude/skills-main/` tree has 116-character paths, and the clone is left
   half-written with ~1,400 files missing (verified 2026-10-19).
7. **Gate**: `npm run release:check -- --project staging` — must print `OK`.
8. **Rehearse on staging** with an explicit project flag on every command, e.g.
   `firebase deploy --project lamax-staging --only firestore:rules,storage`,
   then hosting, then functions. Verify (below).
9. **Gate again for production**: `npm run release:check -- --project production`.
10. **Deploy production from the same checkout**, explicit project on every
    command: rules → functions → hosting (backend before clients, so a client
    never calls a function that does not exist yet). Deploy **all** functions,
    in batches if the Cloud Run instance quota requires, until every function
    carries the release's source.
11. **Verify** and record the release (tag, time, who, verification output).

## Verification

**Hosting** — every staged build publishes `/release-manifest.json`
(`provenance`: `clean` / `dirty` / `unknown`, `commit`, `tags`):

    npm run release:status

A site without a manifest reports `UNKNOWN`. Anything but `CLEAN` at the
release commit is not the release.

What `clean` does **not** cover:

- **Ignored files.** `functions/.env` and other gitignored files never make a
  tree dirty, so configuration and secret drift is invisible to the stamp.
- **Line-ending-only differences** that `git status` hides (see *Hygiene*). A
  fresh clone has none, which is one more reason releases come from one.
- **Edits to a build directory after staging.** The manifest describes the
  source at staging time; deploy immediately after staging, from the same
  checkout.
- **`pushed`** is judged from local remote-tracking refs. Run `git fetch`
  before `release:check`.

**Functions** — read-only, needs `gcloud` auth on the project:

    gcloud functions list --project=lamax-4fd82 --format="value(name.basename(),labels.firebase-functions-hash)"

After a full release every function carries the **same** hash. Several hashes
means the backend is a patchwork again. The source archive per function is at
`gs://gcf-v2-sources-<projectNumber>-europe-west1/<function>/function-source.zip`;
its upload time is the real deploy time. Archives contain the bundled `.env`:
never print or keep them.

**Rules** — compare the released ruleset with the tag:
`firebase deploy --only firestore:rules --dry-run` is not available, so fetch the
live ruleset through the Rules API (`releases` → `rulesets/<id>`) and diff
against `git show <tag>:firestore.rules`. Normalise line endings first.

## Known bypasses (not yet closed)

These still deploy whatever is on disk and do not run the gate. Do not use them
for production releases until they are routed through `release:check`:

- `npm run deploy`, `deploy:aa`, `deploy:admin`, `deploy:rules`, `deploy:all` —
  target the **active** `firebase use` project (no `--project`).
- `npm run deploy:ca` — pins `--project production` but skips the gate.
- Any direct `firebase deploy`.

Staging-built hosting is stamped `dirty`/`clean` either way, so a bypassed
deploy is at least visible in `release:status`.

## Hygiene decisions pending

- `build-admin-dashboard/` (180 files) and `.firebase/*.cache` are tracked;
  `firestore-debug.log` is tracked. They are generated — untrack them.
- `functions/.env.<other-project>` files are uploaded with production
  functions (a `.env.lamax-staging` was found inside a production archive).
  Keep only the target project's env file in the release checkout.
- Line endings are mixed (`i/crlf` and `i/lf` files) and Git for Windows'
  system config sets `core.autocrlf=true` while the user config sets `false`.
  15 files differ from Git only by CRLF and `git status` does not show them.
  Decide a policy (`.gitattributes`) before the release commit.
- Android: `versionCode 1` debug build only; set a release versioning scheme
  before any store upload.
