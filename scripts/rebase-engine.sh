#!/usr/bin/env bash
set -euo pipefail

TARGET_REF="${1:-master}"
BRIDGE_VERSION="${2:-0.13.0-rc.7}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OLD_COMMIT="$(node -p "require('node:fs').readFileSync('scripts/prepare-backend.cjs', 'utf8').match(/const commit = '([^']+)'/)[1]")"

# Fast-path check for upstream master without cloning if already identical
if [[ "$TARGET_REF" == "master" || "$TARGET_REF" == "origin/master" ]]; then
  REMOTE_SHA="$(git ls-remote https://github.com/ggml-org/llama.cpp.git refs/heads/master | awk '{print $1}')"
  if [[ -n "$REMOTE_SHA" && "$REMOTE_SHA" == "$OLD_COMMIT" ]]; then
    echo "Engine already at latest upstream master ($OLD_COMMIT). Skipping rebase."
    exit 0
  fi
fi

WORK_DIR="$(mktemp -d /tmp/pocketpal16-engine-rebase.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
echo "Rebasing engine from $OLD_COMMIT onto $TARGET_REF in $WORK_DIR"

# 1. Unpack pristine bridge and reconstruct current patched working tree
mkdir -p "$WORK_DIR/pristine" "$WORK_DIR/work_old"
npm pack "llama.rn@${BRIDGE_VERSION}" --pack-destination "$WORK_DIR" >/dev/null
tar -xzf "$WORK_DIR/llama.rn-${BRIDGE_VERSION}.tgz" -C "$WORK_DIR/pristine"
cp -a "$WORK_DIR/pristine/package/." "$WORK_DIR/work_old/"
patch -d "$WORK_DIR/work_old" -p1 -f -F 0 -i "$ROOT_DIR/patches/llama-cpp.patch"

# 2. Clone upstream llama.cpp commit graph and deterministically resolve OLD_COMMIT and NEW_COMMIT
git clone --filter=blob:none --no-checkout https://github.com/ggml-org/llama.cpp.git "$WORK_DIR/llama-cpp"
if ! git -C "$WORK_DIR/llama-cpp" cat-file -e "${OLD_COMMIT}^{commit}" 2>/dev/null; then
  git -C "$WORK_DIR/llama-cpp" fetch origin "$OLD_COMMIT"
fi

if git -C "$WORK_DIR/llama-cpp" rev-parse --verify --quiet "origin/${TARGET_REF}^{commit}" >/dev/null; then
  NEW_COMMIT="$(git -C "$WORK_DIR/llama-cpp" rev-parse "origin/${TARGET_REF}^{commit}")"
elif git -C "$WORK_DIR/llama-cpp" rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null; then
  NEW_COMMIT="$(git -C "$WORK_DIR/llama-cpp" rev-parse "${TARGET_REF}^{commit}")"
else
  git -C "$WORK_DIR/llama-cpp" fetch origin "$TARGET_REF"
  NEW_COMMIT="$(git -C "$WORK_DIR/llama-cpp" rev-parse FETCH_HEAD^{commit})"
fi

if [[ "$NEW_COMMIT" == "$OLD_COMMIT" ]]; then
  echo "Target ref $TARGET_REF resolves to current pinned commit ($OLD_COMMIT). Nothing to rebase."
  exit 0
fi
NEW_DATE="$(git -C "$WORK_DIR/llama-cpp" show -s --format=%cs "$NEW_COMMIT")"
echo "Resolved target llama.cpp commit: $NEW_COMMIT ($NEW_DATE)"

# 3. Extract the exact bridge+fork delta on top of OLD_COMMIT
git -C "$WORK_DIR/llama-cpp" checkout -f "$OLD_COMMIT"
BASELINE="$WORK_DIR/llama-cpp" UPDATED="$WORK_DIR/work_old/vendor/llama.cpp" PATCH_OUTPUT="$WORK_DIR/bridge-vendor.patch" node <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {BASELINE: baseline, UPDATED: updated, PATCH_OUTPUT: output} = process.env;
function selected(rel) {
  if (!/\.(?:h|hpp|c|cpp|m|metal)$/.test(rel)) return false;
  if (/^(include|src|common)\//.test(rel)) return true;
  if (/^ggml\/include\//.test(rel)) return true;
  if (/^ggml\/src\/[^/]+$/.test(rel)) return true;
  if (/^ggml\/src\/ggml-(cpu|metal|blas)\//.test(rel))
    return !/\/arch\/(?!arm\/|x86\/|wasm\/)/.test(rel);
  if (/^tools\/mtmd\//.test(rel))
    return !/\/debug\/|\/(mtmd-cli|deprecation-warning)\.cpp$/.test(rel);
  return /^vendor\/(hash|nlohmann|miniaudio|stb)\//.test(rel);
}
const files = new Set();
function walk(base, dir = '') {
  for (const e of fs.readdirSync(path.join(base, dir), {withFileTypes: true})) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['.git', 'node_modules'].includes(rel)) continue;
      walk(base, rel);
    } else if (selected(rel)) files.add(rel);
  }
}
walk(baseline); walk(updated);
const chunks = [];
for (const rel of [...files].sort()) {
  const old = path.join(baseline, rel), next = path.join(updated, rel);
  const hasOld = fs.existsSync(old), hasNext = fs.existsSync(next);
  if (hasOld && hasNext && fs.readFileSync(old).equals(fs.readFileSync(next))) continue;
  const result = spawnSync('git', ['diff', '--no-index', '--no-renames', '--',
    hasOld ? old : '/dev/null', hasNext ? next : '/dev/null'],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (![0, 1].includes(result.status)) throw new Error(result.stderr);
  chunks.push(result.stdout.split('\n').map(line =>
    line.startsWith('diff --git ') ? `diff --git a/${rel} b/${rel}` :
    line.startsWith('--- ') && line !== '--- /dev/null' ? `--- a/${rel}` :
    line.startsWith('+++ ') && line !== '+++ /dev/null' ? `+++ b/${rel}` : line
  ).join('\n'));
}
fs.writeFileSync(output, chunks.join(''));
NODE

# 4. Rebase bridge+fork vendor delta onto NEW_COMMIT
git -C "$WORK_DIR/llama-cpp" checkout -f "$NEW_COMMIT"
if ! git -C "$WORK_DIR/llama-cpp" apply --3way "$WORK_DIR/bridge-vendor.patch"; then
  echo "::error::3-way merge conflict while rebasing bridge-vendor.patch onto llama.cpp $NEW_COMMIT"
  git -C "$WORK_DIR/llama-cpp" status --short
  git -C "$WORK_DIR/llama-cpp" diff
  exit 1
fi

# 5. Construct updated package tree from pristine baseline
mkdir -p "$WORK_DIR/updated"
cp -a "$WORK_DIR/pristine/package/." "$WORK_DIR/updated/"

for wrapper_file in \
  cpp/rn-common.hpp \
  cpp/rn-completion.cpp \
  cpp/rn-slot.cpp \
  cpp/rn-llama.cpp \
  cpp/jsi/RNLlamaJSI.cpp \
  cmake/rnllama-sources.cmake \
  llama-rn.podspec; do
  if [[ -f "$WORK_DIR/work_old/$wrapper_file" ]]; then
    cp -a "$WORK_DIR/work_old/$wrapper_file" "$WORK_DIR/updated/$wrapper_file"
  fi
done

rm -rf "$WORK_DIR/updated/vendor/llama.cpp"
mkdir -p "$WORK_DIR/updated/vendor/llama.cpp"
cp -a "$WORK_DIR/llama-cpp/." "$WORK_DIR/updated/vendor/llama.cpp/"
rm -rf "$WORK_DIR/updated/vendor/llama.cpp/.git"

sed -i.bak -E "s/(LLAMA_COMMIT \")[^\"]+(\")/\1${NEW_COMMIT:0:7}\2/" \
  "$WORK_DIR/updated/vendor/llama.cpp/common/build-info.cpp" 2>/dev/null || true
find "$WORK_DIR/updated/vendor/llama.cpp" -name "*.bak" -delete

# 6. Regenerate patches/llama-cpp.patch against pristine baseline
BASELINE="$WORK_DIR/pristine/package" \
UPDATED="$WORK_DIR/updated" \
PATCH_OUTPUT="$ROOT_DIR/patches/llama-cpp.patch" \
node <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {BASELINE: baseline, UPDATED: updated, PATCH_OUTPUT: output} = process.env;
function selected(rel) {
  if (['cpp/rn-common.hpp', 'cpp/rn-completion.cpp', 'cpp/rn-slot.cpp',
       'cpp/rn-llama.cpp', 'cpp/jsi/RNLlamaJSI.cpp', 'cmake/rnllama-sources.cmake',
       'llama-rn.podspec'].includes(rel)) return true;
  if (!rel.startsWith('vendor/llama.cpp/')) return false;
  const file = rel.slice('vendor/llama.cpp/'.length);
  if (!/\.(?:h|hpp|c|cpp|m|metal)$/.test(file)) return false;
  if (/^(include|src|common)\//.test(file)) return true;
  if (/^ggml\/include\//.test(file)) return true;
  if (/^ggml\/src\/[^/]+$/.test(file)) return true;
  if (/^ggml\/src\/ggml-(cpu|metal|blas)\//.test(file))
    return !/\/arch\/(?!arm\/|x86\/|wasm\/)/.test(file);
  if (/^tools\/mtmd\//.test(file))
    return !/\/debug\/|\/(mtmd-cli|deprecation-warning)\.cpp$/.test(file);
  return /^vendor\/(hash|nlohmann|miniaudio|stb)\//.test(file);
}
const files = new Set();
function walk(base, dir = '') {
  for (const e of fs.readdirSync(path.join(base, dir), {withFileTypes: true})) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (rel.startsWith('vendor/codec') || rel.startsWith('node_modules') ||
          ['example', 'tests', 'ios', 'android', 'lib', 'scripts', '.git'].includes(rel)) continue;
      walk(base, rel);
    } else if (selected(rel)) files.add(rel);
  }
}
walk(baseline); walk(updated);
const chunks = [];
for (const rel of [...files].sort()) {
  const old = path.join(baseline, rel), next = path.join(updated, rel);
  const hasOld = fs.existsSync(old), hasNext = fs.existsSync(next);
  if (hasOld && hasNext && fs.readFileSync(old).equals(fs.readFileSync(next))) continue;
  const result = spawnSync('git', ['diff', '--no-index', '--no-renames', '--',
    hasOld ? old : '/dev/null', hasNext ? next : '/dev/null'],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (![0, 1].includes(result.status)) throw new Error(result.stderr);
  chunks.push(result.stdout.split('\n').map(line =>
    line.startsWith('diff --git ') ? `diff --git a/${rel} b/${rel}` :
    line.startsWith('--- ') && line !== '--- /dev/null' ? `--- a/${rel}` :
    line.startsWith('+++ ') && line !== '+++ /dev/null' ? `+++ b/${rel}` : line
  ).join('\n'));
}
fs.writeFileSync(output, chunks.join(''));
console.log(`Wrote ${chunks.length} file diffs to ${output}`);
NODE

# 7. Update tracked pins in scripts/prepare-backend.cjs and src/updater.ts
NEW_COMMIT="$NEW_COMMIT" NEW_DATE="$NEW_DATE" node <<'NODE'
const fs = require('node:fs');
const commit = process.env.NEW_COMMIT;
const short = commit.slice(0, 12);
const date = process.env.NEW_DATE;

const prepPath = 'scripts/prepare-backend.cjs';
const prep = fs.readFileSync(prepPath, 'utf8');
const nextPrep = prep.replace(/const commit = '[^']+';/, `const commit = '${commit}';`);
if (!nextPrep.includes(`const commit = '${commit}';`)) {
  throw new Error('Failed to update commit in scripts/prepare-backend.cjs');
}
fs.writeFileSync(prepPath, nextPrep);

const updPath = 'src/updater.ts';
const upd = fs.readFileSync(updPath, 'utf8');
const nextUpd = upd
  .replace(/(export const PINNED_LLAMA_CPP_COMMIT =\s*')[^']+(';)/, `$1${commit}$2`)
  .replace(/(export const PINNED_LLAMA_CPP_SHORT = ')[^']+(';)/, `$1${short}$2`)
  .replace(/(export const PINNED_LLAMA_CPP_DATE = ')[^']+(';)/, `$1${date}$2`);
fs.writeFileSync(updPath, nextUpd);
NODE

# 8. If node_modules/llama.rn already exists (local run), reset to pristine and apply new patch
if [[ -d "$ROOT_DIR/node_modules/llama.rn" ]]; then
  rm -rf "$ROOT_DIR/node_modules/llama.rn"
  mkdir -p "$ROOT_DIR/node_modules/llama.rn"
  cp -a "$WORK_DIR/pristine/package/." "$ROOT_DIR/node_modules/llama.rn/"
  node "$ROOT_DIR/scripts/prepare-backend.cjs"
fi

echo "Successfully rebased engine to $NEW_COMMIT ($NEW_DATE)"
