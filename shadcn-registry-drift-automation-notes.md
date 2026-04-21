# shadcn registry, drift checks, and automation — notes

Internal notes summarizing research and decisions from team discussion (2026). This is **not** a substitute for official shadcn docs; it links to those where possible.

## 1. Automation: `watch-shadcn-drift` (companion repo)

**Goal:** Detect when **upstream registry JSON** for vendored shadcn UI in **platform-bible-react** changes relative to a **committed baseline** in this repo, and optionally surface dependency / CLI signals—without spamming the team when nothing needs attention. Legacy **`shadcn add --diff` vs local files** is optional (noisy when every component is customized).

**Shape:**

- **Separate GitHub repo** (e.g. `watch-shadcn-drift`) containing the workflow, drift script, manifest, and **committed registry snapshots** (`snapshots/registry/`, `config/registry-snapshots.json`).
- **Scheduled GitHub Actions** (and `workflow_dispatch`) that:
  - Check out **`paranext/paranext-core`** with a read token (fine-grained PAT; SSO-authorized if needed).
  - Run **`npm ci` at the monorepo root** (this repo uses **npm workspaces** + root `package-lock.json`, not `pnpm install` at root—align with [`.github/workflows/test.yml`](https://github.com/paranext/paranext-core/blob/main/.github/workflows/test.yml)).
  - Use Node from root `package.json` **`volta.node`** (same idea as existing CI).
  - Run **`node scripts/check-shadcn-drift.mjs --paranext-root paranext-core`** (fetches registry JSON per component; compares to snapshots; optional legacy `--diff`).
- **Discord:** **incoming webhook only** (no long-lived bot). **Do not post** when there is nothing actionable; **post one message** when drift or configured “updates needed” buckets are non-empty (`dry_run` skips posting).

**Why full repo checkout:** `platform-bible-react` depends on workspace packages via `file:../…` (e.g. `platform-bible-utils`). Partial clone of only `lib/platform-bible-react` is insufficient for a correct `npm ci`.

**Baseline bumps:** Run `node scripts/update-registry-snapshots.mjs --paranext-root <paranext-core>` and commit changes in **watch-shadcn-drift** when you intentionally align the baseline with the live registry.

## 2. Registry vs `shadcn` package version (FAQ)

**Question:** Does the shadcn registry always deliver the “latest” component definition, or does it return a definition **tied to the version of the `shadcn` npm package** you have installed?

**Practical answer:**

- **`shadcn` on npm is primarily the CLI** (tooling). Your app still uses **checked-in** component files and your **Radix / Tailwind / etc.** versions in `package.json`. The CLI does not ship your UI at runtime like a single `shadcn` runtime package.
- **`add … --diff`** compares **what the registry returns when you run the command** to **your local files**. It is **not** “resolve the component revision that matches my installed `shadcn` semver” in the same sense as npm’s immutable package tarballs.
- The **official registry** is the **live** source of those definitions (URLs in [`components.json`](https://github.com/paranext/paranext-core/blob/main/lib/platform-bible-react/components.json) and defaults). It **evolves over time**. Pinning `shadcn` in **PBR** as a **devDependency** is still useful so everyone uses the **same CLI** for `add` / `diff` / migrations—but it does **not**, by itself, freeze a snapshot of every component’s source the way locking a library version would.
- **Upgrading** “shadcn” improves **reproducibility of the tool**, not automatic updates to vendored files; you still **re-run** `add` or merge diffs when you want new upstream source.

**Nuance:** Different CLI versions can change **how** the tool fetches, parses, or applies registry data (schema, flags). So CLI version matters for **tooling**, not as a 1:1 “registry payload = shadcn package semver” lock.

## 3. Official references

| Topic | Link |
| ----- | ---- |
| CLI (`add`, `--diff`) | [ui.shadcn.com/docs/cli](https://ui.shadcn.com/docs/cli) |
| Registry overview | [ui.shadcn.com/docs/registry](https://ui.shadcn.com/docs/registry) |
| Registry namespaces | [ui.shadcn.com/docs/registry/namespace](https://ui.shadcn.com/docs/registry/namespace) |
| Changelog (CLI / ecosystem) | [ui.shadcn.com/docs/changelog](https://ui.shadcn.com/docs/changelog) |

**Caveat:** The precise sentence “registry is always latest and never tied to CLI semver” may not appear verbatim in one paragraph; the behavior follows from **CLI + registry architecture** in those docs. For ground truth on URLs and payloads, the **shadcn-ui/ui** repo and registry schema are the next step.

## 4. Paranext-specific pointers

| Item | Location |
| ---- | -------- |
| Shadcn config | [`lib/platform-bible-react/components.json`](https://github.com/paranext/paranext-core/blob/main/lib/platform-bible-react/components.json) |
| Vendored primitives | `lib/platform-bible-react/src/components/shadcn-ui/*.tsx` |
| Tailwind prefix in shadcn config | `tw-` (noisy if you diff **CLI output** vs upstream; **registry JSON snapshots** avoid prefix noise in the upstream-identity signal) |
| Extra registry | `@shadcn-editor` → `https://shadcn-editor.vercel.app/r/{name}.json` |
| Workspace name for `npm outdated` | `platform-bible-react` |

## 5. Related work

- **shadcn / Tailwind upgrade investigation** (e.g. Ira Hopkinson) is separate but complementary: drift automation highlights when upstream or local copies diverge; it does not replace a planned upgrade.

## 6. Why snapshot hashes instead of default `--diff` for alerts

Comparing **live registry JSON** (stable-serialized) to **committed snapshots** answers “did **upstream** change since we last recorded it?” Comparing **`add --diff`** to **local vendored files** often reports drift for **every** file after Prettier, `tw-`, lint ignores, and product customizations—so it is a poor **primary** signal for “upstream moved.” This repo therefore:

- **Commits** canonical registry blobs under `snapshots/registry/` and an index in `config/registry-snapshots.json`.
- **Alerts** when the live registry JSON hash differs from the baseline (with `drift-logs/upstream-*.diff` and optional import-line summaries).
- **Optionally** runs legacy **`shadcn add --diff`** for diagnostics (`legacyLocalDiff` / `--include-local-diff`); when `trackUpstreamSnapshots` is true, that output does **not** alone set `updates_needed`.

## 7. Hardening (tests, Discord policy, PBR contract, diff fallback)

- **`discordNotifyOn`** in the manifest controls which buckets can trigger **Discord** (`discord_post` in Actions). **`updates_needed`** stays true for any finding so local runs and **`drift-summary.json`** stay complete.
- **`pbrContract`** in **`registry-snapshots.json` (v2)** records **`style`** and **`registries`** from PBR `components.json`. If they drift without a snapshot refresh, the report calls out **contract vs index** before the per-component upstream list.
- **Unified diff artifacts** use the system **`diff`** command when present, then the **`diff`** npm package, then a short line-oriented fallback so Windows/minimal images still get a non-empty **`drift-logs/upstream-*.diff`**.
- **`editorRegistryComponents`** may use **`{ "spec", "snapshotKey" }`** for a stable filename when the default sanitization could collide.
- Run **`npm test`** in **watch-shadcn-drift** for unit tests on registry helpers.

---

*This document was written to capture team Q&A and design notes. Update it if the companion repo name, workflow behavior, or shadcn’s documented registry model changes.*
