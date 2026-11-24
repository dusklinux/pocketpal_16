#!/usr/bin/env bash
set -euo pipefail

TARGET_REF="${1:-master}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BRIDGE_VERSION="${2:-$(node -p "const v = require('./package.json').dependencies['llama.rn']; if (!v) throw new Error('llama.rn missing from package.json'); v.replace(/^[~^]/, '');")}"
OLD_COMMIT="$(node -p "const m = require('node:fs').readFileSync('scripts/prepare-backend.cjs', 'utf8').match(/const commit = '([^']+)';/); if (!m) throw new Error('Pinned commit not found in scripts/prepare-backend.cjs'); m[1];")"
STATUS_FILE="${REBASE_STATUS_FILE:-}"

WRAPPER_FILES=(
  cpp/rn-common.hpp
  cpp/rn-completion.cpp
  cpp/rn-slot.cpp
  cpp/rn-llama.cpp
  cpp/rn-tts.cpp
  cpp/jsi/RNLlamaJSI.cpp
  cmake/rnllama-sources.cmake
  llama-rn.podspec
)
WRAPPER_FILES_LIST="$(printf '%s\n' "${WRAPPER_FILES[@]}")"

write_status() {
  local changed="$1"
  local commit="$2"
  local date_str="$3"
  if [[ -n "$STATUS_FILE" ]]; then
    {
      echo "changed=${changed}"
      echo "commit=${commit}"
      echo "date=${date_str}"
    } > "$STATUS_FILE"
  fi
}

# Fast-path check for upstream master without cloning if already identical.
if [[ "${FORCE_REBASE:-0}" != "1" ]]; then
  if [[ "$TARGET_REF" == "master" || "$TARGET_REF" == "origin/master" ]]; then
    REMOTE_SHA="$(git ls-remote https://github.com/ggml-org/llama.cpp.git refs/heads/master | awk '{print $1}')"
    if [[ -n "$REMOTE_SHA" && "$REMOTE_SHA" == "$OLD_COMMIT" ]]; then
      echo "Engine already at latest upstream master ($OLD_COMMIT). Skipping rebase."
      write_status "false" "$OLD_COMMIT" ""
      exit 0
    fi
  elif [[ "$TARGET_REF" == "$OLD_COMMIT" ]]; then
    echo "Target commit ($TARGET_REF) matches current pinned commit. Skipping rebase."
    write_status "false" "$OLD_COMMIT" ""
    exit 0
  fi
fi

WORK_DIR="$(mktemp -d /tmp/pocketpal16-engine-rebase.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
echo "Rebasing engine from $OLD_COMMIT onto $TARGET_REF (bridge llama.rn@${BRIDGE_VERSION}) in $WORK_DIR"

# Shared diff generator used for both vendor delta extraction and final patch generation.
cat > "$WORK_DIR/gen-diff.cjs" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const mode = process.argv[2]; // 'vendor-dir' or 'package-patch'
const baseline = process.env.BASELINE;
const updated = process.env.UPDATED;
const output = process.env.PATCH_OUTPUT;

if (!mode || !baseline || !updated || !output) {
  throw new Error('Usage: gen-diff.cjs <vendor-dir|package-patch> with BASELINE, UPDATED, PATCH_OUTPUT');
}

const WRAPPER_FILES = new Set(
  (process.env.WRAPPER_FILES || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean),
);
if (mode === 'package-patch' && WRAPPER_FILES.size === 0) {
  throw new Error('WRAPPER_FILES env var must be non-empty in package-patch mode');
}

const GENERATED_VENDOR_RE = /(?:^|\/)(?:build-info\.cpp|llama-version\.h|ggml-version\.h)$/;

function selectedVendorFile(file) {
  if (!/\.(?:h|hpp|c|cpp|m|metal)$/.test(file)) return false;
  if (/^(include|src|common)\//.test(file)) return true;
  if (/^ggml\/include\//.test(file)) return true;
  if (/^ggml\/src\/[^/]+$/.test(file)) return true;
  if (/^ggml\/src\/ggml-(cpu|metal|blas)\//.test(file)) {
    return !/\/arch\/(?!arm\/|x86\/|wasm\/)/.test(file);
  }
  if (/^tools\/mtmd\//.test(file)) {
    return !/\/debug\/|\/(mtmd-cli|deprecation-warning)\.cpp$/.test(file);
  }
  return /^vendor\/(hash|nlohmann|miniaudio|stb)\//.test(file);
}

function selected(rel) {
  if (mode === 'vendor-dir') {
    if (GENERATED_VENDOR_RE.test(rel)) return false;
    return selectedVendorFile(rel);
  }
  if (WRAPPER_FILES.has(rel)) return true;
  if (!rel.startsWith('vendor/llama.cpp/')) return false;
  return selectedVendorFile(rel.slice('vendor/llama.cpp/'.length));
}

function walk(base, outSet, dir = '') {
  if (!fs.existsSync(path.join(base, dir))) return;
  for (const entry of fs.readdirSync(path.join(base, dir), {withFileTypes: true})) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        (mode === 'package-patch' &&
          (rel.startsWith('vendor/codec') ||
            ['example', 'tests', 'ios', 'android', 'lib', 'scripts'].includes(rel)))
      ) {
        continue;
      }
      walk(base, outSet, rel);
    } else if (selected(rel)) {
      outSet.add(rel);
    }
  }
}

function diffFile(rel) {
  const oldPath = path.join(baseline, rel);
  const nextPath = path.join(updated, rel);
  const hasOld = fs.existsSync(oldPath);
  const hasNext = fs.existsSync(nextPath);
  if (hasOld && hasNext && fs.readFileSync(oldPath).equals(fs.readFileSync(nextPath))) {
    return '';
  }
  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--no-renames',
      '--',
      hasOld ? oldPath : '/dev/null',
      hasNext ? nextPath : '/dev/null',
    ],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024},
  );
  if (![0, 1].includes(result.status)) {
    throw new Error(result.stderr || `git diff failed for ${rel}`);
  }
  return result.stdout
    .split('\n')
    .map(line =>
      line.startsWith('diff --git ')
        ? `diff --git a/${rel} b/${rel}`
        : line.startsWith('--- ') && line !== '--- /dev/null'
          ? `--- a/${rel}`
          : line.startsWith('+++ ') && line !== '+++ /dev/null'
            ? `+++ b/${rel}`
            : line,
    )
    .join('\n');
}

function stripBarbetHunks(rel, rawDiff) {
  const lines = rawDiff.split('\n');
  const header = [];
  const hunks = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (current) hunks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      header.push(line);
    }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) return {diff: rawDiff, stripped: 0};

  const kept = [];
  let stripped = 0;
  let strippedDelta = 0;
  const barbetRe = /barbet/i;
  const bridgeGuardRe =
    /\b(?:vocab_only|progress_callback|rn_llama|mtmd|chat_template|function_gemma)\b/i;

  for (const hunk of hunks) {
    const body = hunk.slice(1);
    const changed = body.filter(
      l =>
        (l.startsWith('+') && !l.startsWith('+++')) ||
        (l.startsWith('-') && !l.startsWith('---')),
    );
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(hunk[0]);
    const oldStart = m ? Number(m[1]) : 0;
    const oldCount = m ? (m[2] === undefined ? 1 : Number(m[2])) : 0;
    const origNewStart = m ? Number(m[3]) : 0;
    const newCount = m ? (m[4] === undefined ? 1 : Number(m[4])) : 0;

    if (changed.some(l => barbetRe.test(l))) {
      if (changed.some(l => bridgeGuardRe.test(l))) {
        throw new Error(
          `Mixed Barbet and bridge hunk detected in ${rel}; refusing to strip blindly.\n${hunk.join('\n')}`,
        );
      }
      stripped += 1;
      strippedDelta += newCount - oldCount;
      continue;
    }

    if (!m || strippedDelta === 0) {
      kept.push(...hunk);
      continue;
    }
    const newStart = origNewStart - strippedDelta;
    const oldSpan = m[2] === undefined ? `${oldStart}` : `${oldStart},${oldCount}`;
    const newSpan = m[4] === undefined ? `${newStart}` : `${newStart},${newCount}`;
    kept.push(`@@ -${oldSpan} +${newSpan} @@${m[5]}`, ...body);
  }

  if (stripped === 0) return {diff: rawDiff, stripped: 0};
  if (kept.length === 0) return {diff: '', stripped};
  let out = [...header, ...kept].join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return {diff: out, stripped};
}

const files = new Set();
walk(baseline, files);
walk(updated, files);
const sorted = [...files].sort();

if (mode === 'vendor-dir') {
  const stripBarbet = process.env.STRIP_BARBET === '1';
  fs.mkdirSync(output, {recursive: true});
  const manifest = [];
  let index = 0;

  for (const rel of sorted) {
    if (stripBarbet && /barbet/i.test(rel)) {
      console.log(`Stripped unused Barbet file from vendor delta: ${rel}`);
      continue;
    }
    let chunk = diffFile(rel);
    if (!chunk) continue;
    if (stripBarbet) {
      const filtered = stripBarbetHunks(rel, chunk);
      if (filtered.stripped > 0) {
        console.log(
          `Stripped ${filtered.stripped} unused Barbet hunk(s) from vendor delta: ${rel}`,
        );
      }
      chunk = filtered.diff;
      if (!chunk) continue;
      if (/\b(?:LLM_ARCH_BARBET|llm_build_barbet)\b/.test(chunk)) {
        throw new Error(`Residual Barbet reference remained in vendor patch for ${rel}`);
      }
    }
    index += 1;
    const patchName = `${String(index).padStart(4, '0')}.patch`;
    fs.writeFileSync(path.join(output, patchName), chunk);
    manifest.push({rel, patchName});
  }

  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Extracted ${manifest.length} per-file vendor patch(es).`);
} else {
  const chunks = [];
  for (const rel of sorted) {
    const chunk = diffFile(rel);
    if (chunk) chunks.push(chunk);
  }
  fs.writeFileSync(output, chunks.join(''));
  console.log(`Wrote ${chunks.length} file diffs to ${output}`);
}
NODE

# 1. Unpack pristine bridge and reconstruct current patched working tree.
mkdir -p "$WORK_DIR/pristine" "$WORK_DIR/work_old"
npm pack "llama.rn@${BRIDGE_VERSION}" --pack-destination "$WORK_DIR" >/dev/null
tar -xzf "$WORK_DIR/llama.rn-${BRIDGE_VERSION}.tgz" -C "$WORK_DIR/pristine"
cp -a "$WORK_DIR/pristine/package/." "$WORK_DIR/work_old/"
patch -d "$WORK_DIR/work_old" -p1 -f -F 0 -i "$ROOT_DIR/patches/llama-cpp.patch"

# Detect whether active compiled wrapper C++ sources reference Barbet symbols.
STRIP_BARBET=1
ACTIVE_WRAPPERS=(
  "$WORK_DIR/work_old/cpp/rn-common.hpp"
  "$WORK_DIR/work_old/cpp/rn-completion.cpp"
  "$WORK_DIR/work_old/cpp/rn-slot.cpp"
  "$WORK_DIR/work_old/cpp/rn-llama.cpp"
  "$WORK_DIR/work_old/cpp/jsi/RNLlamaJSI.cpp"
)
for wf in "${ACTIVE_WRAPPERS[@]}"; do
  if [[ -f "$wf" ]] && grep -qiE '\b(barbet|LLM_ARCH_BARBET|llm_build_barbet)\b' "$wf"; then
    STRIP_BARBET=0
    break
  fi
done
if [[ "$STRIP_BARBET" -eq 1 ]]; then
  echo "Active compiled wrapper C++ sources have zero Barbet references; stripping unused Barbet vendor deltas."
else
  echo "Active compiled wrapper C++ sources reference Barbet; preserving Barbet vendor deltas."
fi

# 2. Clone upstream llama.cpp commit graph and deterministically resolve OLD_COMMIT and NEW_COMMIT.
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
  NEW_COMMIT="$(git -C "$WORK_DIR/llama-cpp" rev-parse "FETCH_HEAD^{commit}")"
fi

if [[ "$NEW_COMMIT" == "$OLD_COMMIT" ]] && [[ "${FORCE_REBASE:-0}" != "1" ]]; then
  echo "Target ref $TARGET_REF resolves to current pinned commit ($OLD_COMMIT). Nothing to rebase."
  write_status "false" "$OLD_COMMIT" ""
  exit 0
fi

NEW_DATE="$(git -C "$WORK_DIR/llama-cpp" show -s --format=%cs "$NEW_COMMIT")"
echo "Resolved target llama.cpp commit: $NEW_COMMIT ($NEW_DATE)"

# 3. Extract per-file bridge+fork vendor patches on top of OLD_COMMIT.
git -C "$WORK_DIR/llama-cpp" checkout -f "$OLD_COMMIT"
BASELINE="$WORK_DIR/llama-cpp" \
UPDATED="$WORK_DIR/work_old/vendor/llama.cpp" \
PATCH_OUTPUT="$WORK_DIR/vendor-patches" \
STRIP_BARBET="$STRIP_BARBET" \
node "$WORK_DIR/gen-diff.cjs" vendor-dir

# 4. Rebase per-file vendor patches onto NEW_COMMIT with pure-additive diff3 fallback.
git -C "$WORK_DIR/llama-cpp" checkout -f "$NEW_COMMIT"
REPO_DIR="$WORK_DIR/llama-cpp" PATCH_DIR="$WORK_DIR/vendor-patches" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const repoDir = process.env.REPO_DIR;
const patchDir = process.env.PATCH_DIR;
const manifest = JSON.parse(fs.readFileSync(path.join(patchDir, 'manifest.json'), 'utf8'));

function resolvePureAdditiveDiff3(content) {
  const lines = content.split('\n');
  const out = [];
  let state = 'normal';
  let ours = [];
  let base = [];
  let theirs = [];
  let resolvedCount = 0;

  for (const line of lines) {
    if (state === 'normal') {
      if (line.startsWith('<<<<<<< ')) {
        state = 'ours';
        ours = [];
        base = [];
        theirs = [];
      } else {
        out.push(line);
      }
    } else if (state === 'ours') {
      if (line.startsWith('||||||| ')) {
        state = 'base';
      } else if (line === '=======') {
        return {ok: false, reason: 'Missing diff3 base marker'};
      } else {
        ours.push(line);
      }
    } else if (state === 'base') {
      if (line === '=======') {
        state = 'theirs';
      } else {
        base.push(line);
      }
    } else if (state === 'theirs') {
      if (line.startsWith('>>>>>>> ')) {
        const nonBlankBase = base.filter(l => l.trim().length > 0);
        if (nonBlankBase.length !== 0) {
          return {
            ok: false,
            reason: `Semantic conflict with non-empty base (${nonBlankBase.length} line(s))`,
          };
        }
        const oursText = ours.join('\n');
        const theirsText = theirs.join('\n');
        if (oursText === theirsText || (theirs.length > 0 && oursText.includes(theirsText))) {
          out.push(...ours);
        } else {
          out.push(...ours, ...theirs);
        }
        resolvedCount += 1;
        state = 'normal';
      } else {
        theirs.push(line);
      }
    }
  }

  if (state !== 'normal') {
    return {ok: false, reason: 'Unterminated conflict marker'};
  }
  return {ok: true, content: out.join('\n'), resolvedCount};
}

const failures = [];

for (const {rel, patchName} of manifest) {
  const patchPath = path.join(patchDir, patchName);
  const res = spawnSync(
    'git',
    ['-c', 'merge.conflictStyle=diff3', '-C', repoDir, 'apply', '--3way', patchPath],
    {encoding: 'utf8'},
  );
  if (res.status === 0) continue;

  const targetFile = path.join(repoDir, rel);
  if (!fs.existsSync(targetFile)) {
    failures.push({rel, reason: 'File deleted or missing in target commit', stderr: res.stderr});
    continue;
  }

  const raw = fs.readFileSync(targetFile, 'utf8');
  if (!raw.includes('<<<<<<< ')) {
    failures.push({rel, reason: 'git apply failed without merge markers', stderr: res.stderr});
    continue;
  }

  const resolution = resolvePureAdditiveDiff3(raw);
  if (!resolution.ok) {
    failures.push({rel, reason: resolution.reason, stderr: res.stderr});
    continue;
  }

  fs.writeFileSync(targetFile, resolution.content);
  const addRes = spawnSync('git', ['-C', repoDir, 'add', '--', rel], {encoding: 'utf8'});
  if (addRes.status !== 0) {
    failures.push({rel, reason: 'git add failed after resolution', stderr: addRes.stderr});
    continue;
  }
  console.log(`Resolved ${resolution.resolvedCount} pure-additive diff3 conflict(s) in ${rel}`);
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`::error::Merge conflict rebasing vendor patch onto ${f.rel}: ${f.reason}`);
    if (f.stderr) console.error(f.stderr.trim());
  }
  spawnSync('git', ['-C', repoDir, 'status', '--short'], {stdio: 'inherit'});
  spawnSync('git', ['-C', repoDir, 'diff'], {stdio: 'inherit'});
  process.exit(1);
}
NODE

# 5. Construct updated package tree from pristine baseline.
mkdir -p "$WORK_DIR/updated"
cp -a "$WORK_DIR/pristine/package/." "$WORK_DIR/updated/"

for wrapper_file in "${WRAPPER_FILES[@]}"; do
  if [[ -f "$WORK_DIR/work_old/$wrapper_file" ]]; then
    cp -a "$WORK_DIR/work_old/$wrapper_file" "$WORK_DIR/updated/$wrapper_file"
  fi
done

rm -rf "$WORK_DIR/updated/vendor/llama.cpp"
mkdir -p "$WORK_DIR/updated/vendor/llama.cpp"
cp -a "$WORK_DIR/llama-cpp/." "$WORK_DIR/updated/vendor/llama.cpp/"
rm -rf "$WORK_DIR/updated/vendor/llama.cpp/.git"

# Stamp generated version/build-info files deterministically and validate podspec CPU exclusions.
WORK_OLD="$WORK_DIR/work_old" \
UPDATED_PKG="$WORK_DIR/updated" \
NEW_COMMIT="$NEW_COMMIT" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const workOld = process.env.WORK_OLD;
const updatedPkg = process.env.UPDATED_PKG;
const commit = process.env.NEW_COMMIT;
const short7 = commit.slice(0, 7);
const oldVendor = path.join(workOld, 'vendor', 'llama.cpp');
const newVendor = path.join(updatedPkg, 'vendor', 'llama.cpp');

function stampBuildInfo() {
  const dst = path.join(newVendor, 'common', 'build-info.cpp');
  const tmpl = path.join(newVendor, 'common', 'build-info.cpp.in');
  const prev = path.join(oldVendor, 'common', 'build-info.cpp');

  if (fs.existsSync(tmpl)) {
    const rendered = fs
      .readFileSync(tmpl, 'utf8')
      .replaceAll('@BUILD_NUMBER@', '0')
      .replaceAll('@BUILD_COMMIT@', short7)
      .replaceAll('@BUILD_COMPILER@', 'clang')
      .replaceAll('@BUILD_TARGET@', 'arm64-apple-ios');
    fs.writeFileSync(dst, rendered);
  } else if (fs.existsSync(prev)) {
    const updated = fs
      .readFileSync(prev, 'utf8')
      .replace(/(LLAMA_BUILD_NUMBER\s*=\s*)\d+/, '$10')
      .replace(/(LLAMA_COMMIT\s*=\s*")[^"]+(")/, `$1${short7}$2`);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.writeFileSync(dst, updated);
  }
}

function stampVersionHeaders() {
  const candidates = [
    'include/llama-version.h',
    'src/llama-version.h',
    'ggml/include/ggml-version.h',
    'ggml/src/ggml-version.h',
  ];
  for (const rel of candidates) {
    const dst = path.join(newVendor, rel);
    const tmpl = `${dst}.in`;
    const prev = path.join(oldVendor, rel);
    if (fs.existsSync(tmpl)) {
      const rendered = fs
        .readFileSync(tmpl, 'utf8')
        .replaceAll('@LLAMA_BUILD_NUMBER@', '0')
        .replaceAll('@BUILD_NUMBER@', '0')
        .replaceAll('@LLAMA_COMMIT@', short7)
        .replaceAll('@GGML_COMMIT@', short7)
        .replaceAll('@BUILD_COMMIT@', short7);
      fs.writeFileSync(dst, rendered);
    } else if (!fs.existsSync(dst) && fs.existsSync(prev)) {
      const updated = fs
        .readFileSync(prev, 'utf8')
        .replace(/(#define\s+(?:LLAMA|GGML)_COMMIT\s+")[^"]+(")/g, `$1${short7}$2`)
        .replace(/(#define\s+(?:LLAMA|GGML)_BUILD_NUMBER\s+)\d+/g, '$10');
      fs.mkdirSync(path.dirname(dst), {recursive: true});
      fs.writeFileSync(dst, updated);
    }
  }
}

function hasCompilableSources(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasCompilableSources(full)) return true;
    } else if (/\.(?:c|cc|cpp|m|mm|s|S)$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

function verifyPodspecCpuExclusions() {
  const podspecPath = path.join(updatedPkg, 'llama-rn.podspec');
  const cpuDir = path.join(newVendor, 'ggml', 'src', 'ggml-cpu');
  if (!fs.existsSync(podspecPath) || !fs.existsSync(cpuDir)) return;

  const podspec = fs.readFileSync(podspecPath, 'utf8');
  const unexcluded = [];

  for (const entry of fs.readdirSync(cpuDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === 'arch' || entry.name === 'tiled') continue;
    const subPath = path.join(cpuDir, entry.name);
    if (!hasCompilableSources(subPath)) continue;
    const tokenRe = new RegExp(`(?:^|[^a-zA-Z0-9_-])${entry.name}(?:[^a-zA-Z0-9_-]|$)`);
    if (!tokenRe.test(podspec)) {
      unexcluded.push(`ggml-cpu/${entry.name}`);
    }
  }

  const archDir = path.join(cpuDir, 'arch');
  if (fs.existsSync(archDir)) {
    for (const name of ['x86', 'wasm']) {
      const subPath = path.join(archDir, name);
      if (!fs.existsSync(subPath) || !fs.statSync(subPath).isDirectory()) continue;
      if (!hasCompilableSources(subPath)) continue;
      if (!podspec.includes(`arch/${name}`)) {
        unexcluded.push(`ggml-cpu/arch/${name}`);
      }
    }
  }

  if (unexcluded.length > 0) {
    throw new Error(
      `New non-ARM CPU source directories are not excluded in llama-rn.podspec: ${unexcluded.join(', ')}`,
    );
  }
}

function verifyPodspecCodecExclusion() {
  const podspecPath = path.join(updatedPkg, 'llama-rn.podspec');
  if (!fs.existsSync(podspecPath)) return;

  const activeLines = fs
    .readFileSync(podspecPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  const codecHits = activeLines.filter(
    line =>
      /(?:vendor\/)?codec\.cpp\b|\bcodec_cpp\b/i.test(line) &&
      !/exclude_files/.test(line),
  );

  if (codecHits.length > 0) {
    throw new Error(
      `vendor/codec.cpp must be excluded from llama-rn.podspec (found active references:\n  ${codecHits.join('\n  ')})`,
    );
  }
}

function verifyTtsStubDecoupled() {
  const ttsPath = path.join(updatedPkg, 'cpp', 'rn-tts.cpp');
  if (!fs.existsSync(ttsPath)) return;

  const ttsSrc = fs.readFileSync(ttsPath, 'utf8');
  if (/^\s*#\s*include\s+["<]codec[^">]*[">]/m.test(ttsSrc)) {
    throw new Error(
      'cpp/rn-tts.cpp still includes a codec.cpp header; text-only stub must not depend on vendor/codec.cpp.',
    );
  }
}

stampBuildInfo();
stampVersionHeaders();
verifyPodspecCpuExclusions();
verifyPodspecCodecExclusion();
verifyTtsStubDecoupled();
NODE

# 6. Regenerate patches/llama-cpp.patch against pristine baseline.
BASELINE="$WORK_DIR/pristine/package" \
UPDATED="$WORK_DIR/updated" \
PATCH_OUTPUT="$ROOT_DIR/patches/llama-cpp.patch" \
WRAPPER_FILES="$WRAPPER_FILES_LIST" \
node "$WORK_DIR/gen-diff.cjs" package-patch

# 7. Update tracked pins in scripts/prepare-backend.cjs and src/updater.ts with strict assertions.
NEW_COMMIT="$NEW_COMMIT" NEW_DATE="$NEW_DATE" node <<'NODE'
const fs = require('node:fs');

const commit = process.env.NEW_COMMIT;
const short12 = commit.slice(0, 12);
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
  .replace(/(export const PINNED_LLAMA_CPP_COMMIT\s*=\s*')[^']+(';)/, `$1${commit}$2`)
  .replace(/(export const PINNED_LLAMA_CPP_SHORT\s*=\s*')[^']+(';)/, `$1${short12}$2`)
  .replace(/(export const PINNED_LLAMA_CPP_DATE\s*=\s*')[^']+(';)/, `$1${date}$2`);

if (
  !nextUpd.includes(`'${commit}'`) ||
  !nextUpd.includes(`'${short12}'`) ||
  !nextUpd.includes(`'${date}'`)
) {
  throw new Error('Failed to update one or more PINNED_LLAMA_CPP_* constants in src/updater.ts');
}
fs.writeFileSync(updPath, nextUpd);
NODE

# 8. If node_modules/llama.rn already exists (local run), reset to pristine and apply new patch.
if [[ -d "$ROOT_DIR/node_modules/llama.rn" ]]; then
  rm -rf "$ROOT_DIR/node_modules/llama.rn"
  mkdir -p "$ROOT_DIR/node_modules/llama.rn"
  cp -a "$WORK_DIR/pristine/package/." "$ROOT_DIR/node_modules/llama.rn/"
  node "$ROOT_DIR/scripts/prepare-backend.cjs"
fi

write_status "true" "$NEW_COMMIT" "$NEW_DATE"
echo "Successfully rebased engine to $NEW_COMMIT ($NEW_DATE)"
