#!/usr/bin/env bash
#
# Release the Obsidian plugin as part of a SmartMemory point-release cut
# (OBSIDIAN-RELEASE-SYNC-SUBMIT-1). The plugin version equals the core version.
#
# Before running: node scripts/set-version.mjs <x.y.z>, commit, push to main.
#
# Usage:
#   scripts/release.sh <x.y.z> --notes <file> [--dry-run]
#
# Env:
#   SMARTMEMORY_SDK_PATH  clean smart-memory-sdk-js checkout at the same release
#                         (default: ../smart-memory-sdk-js). The build must
#                         report dirty=false.
#
# Steps: check version parity and that the tag is new, build, refuse if the
# build changes the committed styles.css or the SDK was dirty, stage the three
# assets under .build/release-<x.y.z>/, then (not with --dry-run) create the
# GitHub release tagged <x.y.z> (no "v") at HEAD with main.js, manifest.json
# and styles.css attached. Obsidian installs the release whose tag equals the
# manifest version exactly.
set -euo pipefail

REPO="smartmemory/smart-memory-obsidian"
VERSION="${1:-}"
shift || true
NOTES=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "release: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be x.y.z with no 'v' (got '$VERSION')"
[[ $DRY_RUN -eq 1 || -n "$NOTES" ]] || die "--notes <file> is required for a real release"
[[ -z "$NOTES" || -f "$NOTES" ]] || die "notes file not found: $NOTES"

node scripts/set-version.mjs --check
MANIFEST_VERSION=$(node -p "require('./manifest.json').version")
[[ "$MANIFEST_VERSION" == "$VERSION" ]] || die "manifest.json is $MANIFEST_VERSION, not $VERSION: run node scripts/set-version.mjs $VERSION and commit"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "tracked files have uncommitted changes"

SHA=$(git rev-parse HEAD)
git fetch -q origin main
if ! git merge-base --is-ancestor "$SHA" origin/main; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "release: WARNING HEAD $SHA is not on origin/main yet (a real release refuses this)"
  else
    die "HEAD $SHA is not on origin/main: land and push first"
  fi
fi
if git ls-remote --exit-code --tags origin "refs/tags/$VERSION" >/dev/null 2>&1; then
  die "tag $VERSION already exists on origin"
fi
if gh release view "$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  die "GitHub release $VERSION already exists"
fi

npm run build
HEADER=$(head -n 1 main.js)
echo "release: main.js header: $HEADER"
[[ "$HEADER" == *"dirty=false"* ]] || die "SDK build was dirty or unstamped: use a clean SDK checkout (SMARTMEMORY_SDK_PATH)"
if ! git diff --quiet -- styles.css; then
  git checkout -- styles.css
  die "the build changed styles.css: rebuild, commit styles.css, and rerun"
fi

OUT=".build/release-$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
cp main.js manifest.json styles.css "$OUT/"
echo "release: assets in $OUT"
(cd "$OUT" && shasum -a 256 main.js manifest.json styles.css)

if [[ $DRY_RUN -eq 1 ]]; then
  echo "release: dry run, no tag or GitHub release created ($VERSION at $SHA)"
  exit 0
fi

gh release create "$VERSION" --repo "$REPO" --target "$SHA" --title "$VERSION" \
  --notes-file "$NOTES" "$OUT/main.js" "$OUT/manifest.json" "$OUT/styles.css"
gh release view "$VERSION" --repo "$REPO" --json tagName,assets \
  -q '"release: published " + .tagName + " assets=" + ([.assets[].name] | join(","))'
