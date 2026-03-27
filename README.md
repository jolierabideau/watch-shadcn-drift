# watch-shadcn-drift

Scheduled GitHub Actions workflow that checks **[paranext/paranext-core](https://github.com/paranext/paranext-core)** for:

1. **Upstream registry drift** — Fetches the **registry JSON** for each tracked component (same URLs as [`lib/platform-bible-react/components.json`](https://github.com/paranext/paranext-core/blob/main/lib/platform-bible-react/components.json): default `https://ui.shadcn.com/r/styles/{style}/{name}.json`, plus namespaced registries such as `@shadcn-editor`). Compares a **stable serialization** of that JSON to committed **snapshots** under [`snapshots/registry/`](snapshots/registry/) and metadata in [`config/registry-snapshots.json`](config/registry-snapshots.json). When something changes upstream, the workflow writes **`drift-logs/upstream-<key>.diff`** (unified diff vs the last snapshot) and optional **`upstream-<key>-imports.txt`** (import-line delta). This answers “did the registry move?” without comparing to heavily customized local files.
2. **Allowlisted npm drift** — `npm outdated -w platform-bible-react` intersected with [`config/shadcn-drift-manifest.json`](config/shadcn-drift-manifest.json).
3. **Shadcn CLI** — compares the pinned CLI version in the manifest to `npm view shadcn version`.

**Optional (legacy):** `shadcn add <name> --diff` against vendored files — enable with `legacyLocalDiff: true` in the manifest or **`--include-local-diff`** on the check script. **Does not** set `updates_needed` when `trackUpstreamSnapshots` is true (informational only); it is the primary drift signal only when **`trackUpstreamSnapshots`** is **false**.

If **nothing** needs attention, **no Discord message** is sent. If any bucket is non-empty, **one** message is posted to a Discord incoming webhook with a short summary and links to the Actions run and the checked-out commit.

---

## Registry snapshots and baselines

- **Canonical blob:** Parsed registry JSON is re-serialized with **sorted object keys** ([`scripts/lib/registry-snapshot.mjs`](scripts/lib/registry-snapshot.mjs)) so hashes are stable.
- **When upstream changes:** Refresh committed snapshots and the index from a **paranext-core** checkout with network access:

  ```bash
  cd /path/to/watch-shadcn-drift
  node scripts/update-registry-snapshots.mjs --paranext-root /path/to/paranext-core
  ```

  Commit `snapshots/registry/*.json` and `config/registry-snapshots.json` in **this** repo (e.g. a PR in `watch-shadcn-drift` after you merge or plan upstream changes).

- **Missing baseline:** If a tracked component has no snapshot file, the check lists it under **Missing registry baselines** and sets `updates_needed` until you run the update script.

---

## Running in CI (GitHub Actions)

Workflow file: [`.github/workflows/shadcn-drift.yml`](.github/workflows/shadcn-drift.yml).

### One-time setup

1. Push this repo to GitHub (if it is not already).
2. Add repository **Secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `PARANEXT_READ_TOKEN` | PAT with **Contents: Read** on `paranext/paranext-core`. Needed because the workflow checks out a **second** repository; the default `GITHUB_TOKEN` only applies to **watch-shadcn-drift**, not to cross-repo clones. Use a fine-grained PAT on that repo only (or an appropriate classic PAT). If your org uses SAML SSO, **authorize** the token for the org. |
| `DISCORD_SHADCN_WEBHOOK_URL` | Full URL of a [Discord incoming webhook](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks). Required when you want notifications; if missing and the workflow tries to post, that step fails with an error. |

**Rotating credentials:** replace the PAT or webhook in GitHub/Discord settings, update secrets, then delete the old credentials. Document **who owns** renewal in your team runbook.

### What runs on each job

1. Checkout **watch-shadcn-drift** (this repo — workflow, scripts, manifest, snapshots).
2. Checkout **paranext/paranext-core** into `paranext-core/` (shallow, ref below).
3. Read **Node** from `paranext-core/package.json` **`volta.node`** and run **`actions/setup-node`** with **npm cache** on `paranext-core/package-lock.json`.
4. **`npm ci`** in **`paranext-core/`** (monorepo root, same idea as upstream [`.github/workflows/test.yml`](https://github.com/paranext/paranext-core/blob/main/.github/workflows/test.yml)).
5. **`node scripts/check-shadcn-drift.mjs --paranext-root paranext-core`** — writes `GITHUB_OUTPUT` `updates_needed`, `drift-summary.json`, `discord-payload.json`, and `drift-logs/`.
6. **Discord:** `POST` `discord-payload.json` **only if** `updates_needed == true` **and** the run is **not** a `workflow_dispatch` with **`dry_run: true`**. If `updates_needed` is false, the Discord step is **skipped** (no API call).
7. **Artifacts:** uploads `drift-logs/`, `drift-summary.json`, and `discord-payload.json` when the drift step ran (even on failure of later steps, if logs exist).

**Triggers**

| Trigger | When it runs |
|---------|--------------|
| **Schedule** | Mondays **09:00 UTC** (`cron: 0 9 * * 1`). Checks **`main`** on paranext-core (same as default `ref` below). |
| **workflow_dispatch** | On demand from the Actions tab. |

**`workflow_dispatch` inputs**

| Input | Purpose |
|-------|---------|
| **`ref`** | Git ref for **paranext-core** only: branch, tag, or commit (default **`main`**). |
| **`dry_run`** | If **`true`**, runs the full check and uploads artifacts but **never** posts to Discord (useful for testing). |

**Manual run:** GitHub → **Actions** → **Shadcn drift check** → **Run workflow** → choose `ref` / `dry_run` → **Run workflow**.

**Failures:** install or script errors fail the job; **Discord is not used** as a failure notifier by default (check the Actions log and artifacts).

---

## Running locally (without GitHub Actions)

Use the same entrypoint the workflow uses: **`scripts/check-shadcn-drift.mjs`**. Always run commands from the **root of this repo** (`watch-shadcn-drift`) so `config/shadcn-drift-manifest.json` resolves correctly.

**Prerequisites**

- **Node:** match `volta.node` in your **paranext-core** `package.json` when you can.
- **Network:** registry fetches, `npm outdated`, and `npm view shadcn` need registry access.

### Option A — Use your existing `paranext-core` clone

Use whatever branch/commit you already have checked out.

```bash
cd /path/to/watch-shadcn-drift

npm ci --prefix /path/to/paranext-core   # repeat when lockfile or deps change

node scripts/check-shadcn-drift.mjs --paranext-root /path/to/paranext-core
```

Add **`--plain`** to disable ANSI colors (e.g. when piping to a file). Add **`--include-local-diff`** to run legacy **`shadcn add --diff`** logs (see manifest `legacyLocalDiff`).

If the two repos are siblings:

```bash
npm ci --prefix ../paranext-core
node scripts/check-shadcn-drift.mjs --paranext-root ../paranext-core
```

### Option B — No long-lived clone (fresh tree from GitHub)

Clones **shallow** into a temp directory, runs `npm ci` and the drift script, then deletes the temp dir.

```bash
cd /path/to/watch-shadcn-drift

./scripts/run-with-remote-paranext.sh              # default: branch main
./scripts/run-with-remote-paranext.sh release-prep # another branch or tag
```

- **Private** `paranext/paranext-core`: export **`PARANEXT_READ_TOKEN`** (same role as the Actions secret).
- **Fork:** `PARANEXT_GITHUB_REPOSITORY=owner/repo ./scripts/run-with-remote-paranext.sh`

This still **clones on disk briefly**; it does not stream-only from the API. **`npm ci`** needs a real tree and `node_modules`.

### Outputs (local and CI)

| Output | Description |
|--------|-------------|
| **Stdout** | First line: `updates_needed=true` or `false`. When true, a **formatted report** (terminal): upstream snapshot changes, missing baselines, fetch errors, allowlisted **npm outdated**, **newer shadcn CLI** vs manifest pin, and optional legacy **local `--diff`** listing. |
| **`drift-summary.json`** | JSON breakdown (`upstreamChanged`, `missingBaseline`, `upstreamFetchErrors`, packages, CLI, optional local diff). In `.gitignore`. |
| **`drift-logs/`** | `upstream-*.diff`, `upstream-*-imports.txt`, and optional `default-*.log` / `editor-*.log` for legacy `--diff`. In `.gitignore`. |
| **`discord-payload.json`** | JSON for Discord `content` (markdown with the same sections + short **Note** lines). In `.gitignore`. |

### Local vs CI

| | Local | CI |
|---|--------|-----|
| **`GITHUB_OUTPUT`** | Not set; ignore step outputs. | Set; drives Discord `if:` and the UI. |
| **Discord** | Not sent by the script. | Sent when `updates_needed` and not `dry_run`. |

### Optional: send the same payload to Discord from your machine

After a local run where `updates_needed` is true:

```bash
curl -X POST -H "Content-Type: application/json" -d @discord-payload.json "$DISCORD_SHADCN_WEBHOOK_URL"
```

Prefer a test webhook/channel when experimenting.

---

## Configuration

- **Manifest:** [`config/shadcn-drift-manifest.json`](config/shadcn-drift-manifest.json) — `shadcnCliVersion`, **`trackUpstreamSnapshots`** (default `true`), **`legacyLocalDiff`** (default `false`), `excludeComponents`, `editorRegistryComponents` (`@shadcn-editor/...` names), and `outdatedPackageAllowlist`.
- **Snapshot index:** [`config/registry-snapshots.json`](config/registry-snapshots.json) — per-key `sha256`, `registryUrl`, `capturedAt`, etc. (generated by `update-registry-snapshots.mjs`).
- **Scripts:** [`scripts/check-shadcn-drift.mjs`](scripts/check-shadcn-drift.mjs), [`scripts/update-registry-snapshots.mjs`](scripts/update-registry-snapshots.mjs), [`scripts/run-with-remote-paranext.sh`](scripts/run-with-remote-paranext.sh).

## Discord message limits

Summaries omit raw file diffs. Discord `content` is capped at **2000** characters in the API; the drift script truncates around **1900** with a pointer to artifacts for full logs.

## References

- [shadcn CLI](https://ui.shadcn.com/docs/cli) (`add`, `--diff`)
- [Registry](https://ui.shadcn.com/docs/registry)
