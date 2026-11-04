#!/usr/bin/env bash
set -euo pipefail

OLD_COMMIT="c83f3058b6f876f2f7e6ccbada858b2446860c85"
TARGET_REF="${1:-20a51f24a852}"
BRIDGE_VERSION="${2:-0.13.0-rc.7}"

ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d /tmp/pocketpal16-engine-rebase.XXXXXX)"
echo "Working in $WORK_DIR"

# 1. Unpack pristine current bridge (0.13.0-rc.7) and reconstruct current patched tree
mkdir -p "$WORK_DIR/rc7" "$WORK_DIR/work_old"
npm pack "llama.rn@0.13.0-rc.7" --pack-destination "$WORK_DIR" >/dev/null
tar -xzf "$WORK_DIR/llama.rn-0.13.0-rc.7.tgz" -C "$WORK_DIR/rc7"
cp -a "$WORK_DIR/rc7/package/." "$WORK_DIR/work_old/"
patch -d "$WORK_DIR/work_old" -p1 -f -F 0 -i "$ROOT_DIR/patches/llama-cpp.patch"

# 2. Fetch upstream llama.cpp at OLD_COMMIT and TARGET_REF
git clone --filter=blob:none https://github.com/ggml-org/llama.cpp.git "$WORK_DIR/llama-cpp"
git -C "$WORK_DIR/llama-cpp" fetch origin "$OLD_COMMIT"
NEW_COMMIT="$(git -C "$WORK_DIR/llama-cpp" rev-parse "$TARGET_REF^{commit}")"
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
  chunks.push(result.stdout.split('\n').map(line =>
    line.startsWith('diff --git ') ? `diff --git a/${rel} b/${rel}` :
    line.startsWith('--- ') && line !== '--- /dev/null' ? `--- a/${rel}` :
    line.startsWith('+++ ') && line !== '+++ /dev/null' ? `+++ b/${rel}` : line
  ).join('\n'));
}
fs.writeFileSync(output, chunks.join(''));
NODE

# 4. Rebase the bridge+fork vendor delta onto NEW_COMMIT in upstream llama.cpp
git -C "$WORK_DIR/llama-cpp" checkout -f "$NEW_COMMIT"
git -C "$WORK_DIR/llama-cpp" apply --3way "$WORK_DIR/bridge-vendor.patch"

# 5. Prepare target pristine baseline ($WORK_DIR/target_pristine) and updated package ($WORK_DIR/updated)
mkdir -p "$WORK_DIR/target_pristine" "$WORK_DIR/updated"
npm pack "llama.rn@${BRIDGE_VERSION}" --pack-destination "$WORK_DIR" >/dev/null
tar -xzf "$WORK_DIR/llama.rn-${BRIDGE_VERSION}.tgz" -C "$WORK_DIR/target_pristine"
cp -a "$WORK_DIR/target_pristine/package/." "$WORK_DIR/updated/"

# Copy adapted wrapper, CMake, and iOS 16 podspec files
for wrapper_file in \
  cpp/rn-common.hpp \
  cpp/rn-completion.cpp \
  cpp/rn-slot.cpp \
  cpp/rn-llama.cpp \
  cpp/jsi/RNLlamaJSI.cpp \
  cmake/rnllama-sources.cmake \
  llama-rn.podspec; do
  cp -a "$WORK_DIR/work_old/$wrapper_file" "$WORK_DIR/updated/$wrapper_file"
done

# Replace vendor/llama.cpp with the cleanly rebased upstream tree (honoring upstream file removals)
rm -rf "$WORK_DIR/updated/vendor/llama.cpp"
mkdir -p "$WORK_DIR/updated/vendor/llama.cpp"
cp -a "$WORK_DIR/llama-cpp/." "$WORK_DIR/updated/vendor/llama.cpp/"
rm -rf "$WORK_DIR/updated/vendor/llama.cpp/.git"

# Update generated version headers in vendor/llama.cpp
sed -i.bak -E "s/(LLAMA_COMMIT \")[^\"]+(\")/\1${NEW_COMMIT:0:7}\2/" \
  "$WORK_DIR/updated/vendor/llama.cpp/common/build-info.cpp" 2>/dev/null || true
find "$WORK_DIR/updated/vendor/llama.cpp" -name "*.bak" -delete

# 6. Generate the new zero-fuzz patches/llama-cpp.patch using the AGENTS.md generator
BASELINE="$WORK_DIR/target_pristine/package" \
UPDATED="$WORK_DIR/updated" \
PATCH_OUTPUT="$ROOT_DIR/patches/llama-cpp.patch" \
node <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {BASELINE: baseline, UPDATED: updated, PATCH_OUTPUT: output} = process.env;
if (!baseline || !updated || !output) throw Error('Set all three paths');
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
  if (![0, 1].includes(result.status)) throw Error(result.stderr);
  chunks.push(result.stdout.split('\n').map(line =>
    line.startsWith('diff --git ') ? `diff --git a/${rel} b/${rel}` :
    line.startsWith('--- ') && line !== '--- /dev/null' ? `--- a/${rel}` :
    line.startsWith('+++ ') && line !== '+++ /dev/null' ? `+++ b/${rel}` : line
  ).join('\n'));
}
fs.writeFileSync(output, chunks.join(''));
console.log(`Wrote ${chunks.length} file diffs to ${output}`);
NODE

echo "NEW_COMMIT=$NEW_COMMIT"
echo "NEW_SHORT=${NEW_COMMIT:0:12}"
echo "NEW_DATE=$NEW_DATE"
