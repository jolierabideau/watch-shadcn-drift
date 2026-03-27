#!/usr/bin/env bash
# Ephemeral clone of paranext-core from GitHub, then run check-shadcn-drift.mjs.
# No long-lived local clone required; the temp directory is removed on exit.
#
# Usage (from watch-shadcn-drift repo root):
#   ./scripts/run-with-remote-paranext.sh              # default: main
#   ./scripts/run-with-remote-paranext.sh release-prep # branch or tag
#   PARANEXT_REF=abc1234 ./scripts/run-with-remote-paranext.sh  # short SHA (see note)
#
# Private repo: set PARANEXT_READ_TOKEN (same as GitHub Actions secret).
# The token is embedded in the HTTPS clone URL (GitHub's supported pattern). It can
# surface in process listings (e.g. ps) or some tools’ error output; CI usually masks
# secrets, but locally treat terminal output and screen shares accordingly.
# Override repo: PARANEXT_GITHUB_REPOSITORY=owner/paranext-fork ./scripts/run-with-remote-paranext.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$WATCH_ROOT"

REPO="${PARANEXT_GITHUB_REPOSITORY:-paranext/paranext-core}"
REF="${1:-${PARANEXT_REF:-main}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/paranext-core-XXXXXX")"
DEST="${TMP}/paranext-core"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

# Token-in-URL: see header note (possible ps / stderr exposure; CI masking vs local).
clone_url() {
  if [[ -n "${PARANEXT_READ_TOKEN:-}" ]]; then
    echo "https://x-access-token:${PARANEXT_READ_TOKEN}@github.com/${REPO}.git"
  else
    echo "https://github.com/${REPO}.git"
  fi
}

URL="$(clone_url)"

echo "Fetching ${REPO} @ ${REF} into temp dir..."

if git clone --depth 1 --branch "${REF}" "${URL}" "${DEST}" 2>/dev/null; then
  :
else
  rm -rf "${DEST}"
  mkdir -p "${DEST}"
  git -C "${DEST}" init -q
  git -C "${DEST}" remote add origin "${URL}"
  # Works for branches, tags, and full SHAs (shallow fetch of that commit).
  if ! git -C "${DEST}" fetch --depth 1 origin "${REF}"; then
    echo "git fetch failed. For a private repo set PARANEXT_READ_TOKEN." >&2
    exit 1
  fi
  git -C "${DEST}" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi

echo "npm ci (this may take several minutes)..."
npm ci --prefix "${DEST}"

echo "Running drift check..."
node "${WATCH_ROOT}/scripts/check-shadcn-drift.mjs" --paranext-root "${DEST}"

echo "Done."
