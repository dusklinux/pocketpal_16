# PocketPal 16: instructions for future agents

## Scope and working baseline

This repository is an offline, text-only PocketPal fork for jailbroken iOS 16. Preserve chat, GGUF import through Files/SSH, saved conversations, generation settings, light/dark/system appearance, and optional fullscreen chat. Keep CPU as the default. Do not restore accounts, network services, model downloads, voice, vision, tools, benchmarks, or other removed features while updating inference.

Before editing, inspect `git status` and relevant diffs; preserve unrelated user changes. An engine update request authorizes implementation and verification, but commit/push/install only when the current user authorizes those actions. Do not commit credentials, models, IPAs, build logs, `node_modules`, or device data. Use current SSH authentication; never put passwords in documentation or commands.

This file documents the baseline established on October 12, 2026. Versions below are historical pins, not a claim that they remain latest. Inspect the actual checkout and verify upstream before choosing an update.

| Component | Baseline |
| --- | --- |
| Inference engine | llama.cpp `c83f3058b6f876f2f7e6ccbada858b2446860c85`, upstream master checked October 11, 2026 |
| Native React Native bridge | `llama.rn` `0.13.0-rc.7`, with this repository's patch |
| App runtime | React Native `0.87.1`, React `19.2.3` |
| Target | arm64 iOS, deployment target **16.0** |
| Bundle identifier | `ai.pocketpal16`; keep it to preserve app data across updates |
| Device tested | iPhone 8 Plus, A11, approximately 3 GB RAM, jailbroken iOS **16.7.16** |
| Installer tested | TrollStore Lite **2.1.1**, jailbreak-dependent |
| Model tested | LiquidAI `LFM2.5-1.2B-Instruct-Q4_K_M.gguf`, 730895168 bytes (about 697 MiB) |
| Model SHA-256 | `b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5` |

The model loaded and generated multi-turn text on the phone using CPU. Metal loading failed; the exact native cause was not established. Do not claim Metal works, automatically falls back, or has been fixed without a device test. Inference speed and peak memory were not measured.

The [final full build](https://github.com/dusklinux/pocketpal_16/actions/runs/38165509574) succeeded from commit `e265e97038d3e219320a4c271962a14990a01c8d`. Its IPA was installed through TrollStore Lite successfully. The earlier CPU generation test preceded this final installation; installation success alone is not a fresh inference test.

## Read these files before changing the engine

| File | Purpose |
| --- | --- |
| `package.json`, `yarn.lock` | Exact package pins and install/build commands |
| `patches/llama-cpp.patch` | Full delta from the pristine npm llama.rn package to our vendored engine and adapted wrapper |
| `scripts/prepare-backend.cjs` | Applies the patch, embeds updated Metal sources, writes version metadata and a checksum marker |
| `ios/Podfile` | Forces `RNLLAMA_BUILD_FROM_SOURCE=1`, deployment target 16.0 |
| `scripts/build-ios.sh` | Checks, CocoaPods, native release build, deployment verification, signing, IPA packaging |
| `.github/workflows/build-ios16.yml` | Manual macOS build and artifact upload |
| `src/controller.ts`, `src/chat.ts` | Model lifecycle, prompt/context budgeting, cancellation and defaults |
| `ios/PocketPal/RuntimeModule.mm` | Persistence and other native app helpers |
| `ios/PocketPal/PocketPal.entitlements` | Retained memory entitlements |
| `scripts/update-js-ipa.py` | UI-only update helper; **cannot update the native engine** |

After installing dependencies, inspect `node_modules/llama.rn/{cpp,cmake,ios,vendor/llama.cpp}` as needed. The package's `llama-rn.podspec` is modified by our patch. Editing only installed dependencies produces changes that vanish on reinstall; every required change must be represented by tracked files.

## How the current integration works

`RNLLAMA_SKIP_POSTINSTALL=1` skips llama.rn's downloaded prebuilt backend. It does **not** skip this app's root postinstall, which runs `scripts/prepare-backend.cjs`. The iOS Podfile separately forces compilation of patched native source. Retain both settings.

The preparation script requires exactly llama.rn `0.13.0-rc.7` and applies `patch -p1 -f -F 0` inside that package. `.pocketpal16-backend` stores the SHA-256 of the patch. A changed patch with an old marker intentionally fails: reinstall a pristine package rather than deleting the marker on an already patched tree. A failed application can leave partial edits; discard that scratch package before retrying.

The script deletes stale `ggml-metal-embed*.s` files and generates assembly containing the updated Metal kernel source. It expands quoted includes and fails on unresolved includes. These embedded files are generated, not maintained by hand. Successful assembly does not prove the shaders compile or execute on the phone.

Version metadata is updated in `src/version.ts`, `lib/commonjs/version.js`, and `lib/module/version.js`. The current substitutions assume pristine package values `11385` and `bf9a0cc`; inspect and update that logic if the bridge package changes. The replacement build number `0` is a placeholder, not an upstream release number. The full pinned commit in the script and README is the authoritative engine identity. Generated `llama-version.h` and `ggml-version.h` also need to agree with the new source/version templates.

Runtime defaults: context 1024, output 256, batch/ubatch 128, one parallel slot, mmap enabled, mlock disabled, flash attention off. CPU uses `n_gpu_layers: 0` and `devices: ['CPU']`; explicit Metal selection uses 99 GPU layers. Context/backend changes unload the model. The last successful selection is saved in `Library/pocketpal16.json` as `lastModel`, rebased after container moves, and loaded on the first nonblank composer edit or Send/Retry if no context is loaded. A lone GGUF is the initial default; multiple unselected models need one explicit selection. Loading keeps the composer editable, while generation and other busy operations do not. Do not allocate a context just from opening the app. Preserve those behaviors unless the user requests a change or a measured issue justifies one.

## Updating llama.cpp

1. **Choose and record an exact upstream commit.** Use [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) and [mybigday/llama.rn](https://github.com/mybigday/llama.rn) as primary sources. Check current upstream, architecture support, API changes, and iOS requirements. Fetch once, resolve the chosen ref to a full SHA, and keep that SHA fixed throughout the update. Do not fetch moving master during every app install.
2. **Choose the bridge strategy.** A newer llama.rn release may already integrate the desired engine. Inspect it before replacing our bridge pin. If updating the bridge, regenerate the lockfile, change the version assertion, and rebase all remaining app-specific changes against that exact pristine npm package. `npm install llama.rn@latest` alone is not an engine upgrade for this fork.
3. **Create pristine and working package trees outside the app's installed dependencies.** Obtain the exact npm tarball with `npm pack llama.rn@<version>` in a scratch directory and extract it without running scripts. Keep one copy untouched as the patch baseline. Copy it to a second working tree and apply the existing repository patch to reproduce the current integration before changing anything.
4. **Obtain the old and new upstream source trees.** The old pin is listed above; read the preparation script for the actual current pin. Compare our patched vendored tree against old upstream to identify wrapper-specific deltas. Replace the working copy's vendored tree with the chosen new upstream tree, then reapply/rebase the needed deltas. Treat upstream file removals as removals; do not overlay new files onto an old tree and leave stale translation units behind.
5. **Preserve bridge-required upstream modifications.** The pristine npm tarball already includes llama.rn changes to its old engine. Consult the matching llama.rn source revision's `scripts/patches/llama.cpp/` and `scripts/update-llama-cpp.sh`/`scripts/sync-vendor.sh`; these scripts are not necessarily included in the npm tarball. Rebase deliberately, without blindly replaying old patches. Existing integration includes vocabulary-only loading, progress callback forwarding, sampling/reasoning fields, chat-template changes, FunctionGemma handling, Barbet enum/model registration and implementation, mmap/Jinja/mtmd adaptations, and Metal changes. Keep changes required by compiled wrapper APIs even when the UI does not expose those features. Android-only logging changes were omitted. Inspect actual diffs because upstream can absorb or replace these modifications.
6. **Adapt the wrapper to changed APIs.** Read headers and call sites; do not guess field replacements. The current wrapper exposes raw text rather than serialized PEG parsers or structured tool/reasoning output. Review both single and parallel completion code, JSI bindings, model loading and backend metadata. Compile with Metal enabled as well as CPU: CPU-only testing previously missed a real iOS compile failure.
7. **Update source selection and Metal generation.** Inspect the working package's podspec and CMake lists for newly added, removed, or platform-specific files. Check upstream Metal file layout/includes against `prepare-backend.cjs`. Generate version headers needed by direct source builds; CocoaPods does not automatically run upstream CMake configuration.
8. **Regenerate the complete patch against the pristine npm baseline.** Include both the engine changes and wrapper/podspec/CMake adaptations. Never generate it against already patched `node_modules`, and never replace it with only the newest incremental diff. The generator below reproduces the current file-selection policy; extend it if the new integration needs other paths/extensions.
9. **Update tracked metadata.** Change the full commit in `prepare-backend.cjs`, the README engine link/date, and this baseline once verified. If the package version changes, update `package.json`, `yarn.lock`, the preparation assertion and version substitutions together. Do not label an untested update verified.
10. **Reinstall, test, and build a full IPA.** Follow the verification and build sections below. Report the actual native API changes, tests performed and any device limitations. Push only when authorized; pushing alone does not trigger this manual workflow.

### Patch generator

Set `BASELINE` to the untouched extracted **package directory**, `UPDATED` to the complete updated package directory, and `PATCH_OUTPUT` to a temporary output filename. Run this from any directory. Inspect its result before replacing `patches/llama-cpp.patch`.

```sh
BASELINE=/path/to/pristine/package UPDATED=/path/to/updated/package PATCH_OUTPUT=/path/to/new.patch node <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {BASELINE: baseline, UPDATED: updated, PATCH_OUTPUT: output} = process.env;
if (!baseline || !updated || !output) throw Error('Set all three paths');
function selected(rel) {
  if (['cpp/rn-common.hpp', 'cpp/rn-completion.cpp', 'cpp/rn-slot.cpp',
       'cpp/jsi/RNLlamaJSI.cpp', 'cmake/rnllama-sources.cmake',
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
    {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
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
```

This is a text-source patch generator for POSIX hosts with Node and Git. It excludes generated embedding assembly, package build artifacts and version metadata handled by preparation. It includes upstream source that the podspec may exclude from compilation. It does **not** automatically detect new bridge paths or necessary build-system changes: extend its selection when needed, and compare every required edited file with a freshly reconstructed package.

## Known build failures and fixes to preserve

- **Linux/RISC-V code accidentally compiled for iOS:** `ggml-cpu/spacemit/spine_mem_pool.cpp` failed with Linux-only `MADV_HUGEPAGE` and logging issues. The podspec excludes unsupported/unconfigured directories recursively: `{kleidiai,llamafile,amx,spacemit,arch/x86,arch/wasm}/**/*`. Retain ARM and generic CPU sources. Inspect new directories on each update; do not paper over this by defining Linux constants on iOS. The podspec also excludes upstream mtmd CLI/debug runners and `common/jinja/string.h` from the header map to avoid shadowing the system header.
- **Removed Metal property:** old `supports_gpu_family_apple7` no longer existed. In this baseline, `cpp/rn-common.hpp` maps the metadata flag to `metal_props->gpu_family >= 7`, based on the actual upstream header/implementation. Recheck semantics on a later update; preserve metadata keys expected by the bridge.
- **PEG parser API changed:** `cpp/jsi/RNLlamaJSI.cpp` no longer serializes `chatParams.parser`; `cpp/rn-completion.cpp` and `cpp/rn-slot.cpp` return raw accumulated text. Do not restore the old parser calls when rebasing.
- **Native integration versus upstream CMake:** direct CocoaPods source compilation needs the correct include order, generated version headers and explicit source exclusions. Do not assume success of standalone upstream CMake proves the wrapper builds.
- **Compiler warnings versus failures:** documentation warnings and “script phase runs every build” warnings were not the cause of the earlier failures. Find the first actual `error:` and the failed compilation command in `ios-build-log`.

## Verification before publication

Reconstruct from a fresh package and apply the new patch with zero fuzz. Check for rejects and compare required source files with the intended working tree. Run preparation twice to check idempotence. Verify changing the patch triggers the marker mismatch rather than silently accepting stale native sources.

```sh
RNLLAMA_SKIP_POSTINSTALL=1 npx --yes yarn@1.22.22 install --frozen-lockfile --non-interactive
node scripts/prepare-backend.cjs
npm run lint
npm run typecheck
npm test
npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output /tmp/pocketpal16.jsbundle
```

If `node_modules/llama.rn` is already patched with an older patch, remove **that package directory** and reinstall before these checks. Do not delete unrelated user files. Check the emitted version metadata and newly embedded Metal assembly against the intended engine pin.

The historical baseline passed 28 app tests, nine native wrapper tests, wrapper JSI syntax checks against RN 0.87.1, seven Metal-enabled wrapper C++ syntax checks, arm64 iOS embedding assembly checks, a full Xcode IPA build, and real LFM CPU generation on Linux and the phone. Those results do not carry over automatically to an updated engine. JavaScript tests mock native modules.

For native host checks, obtain the matching bridge source test harness (the npm package may omit tests), ensure it compiles the **same patched sources**, and run relevant tests with their required fixture GGUF. A standalone llama.cpp CLI test supplements but does not replace wrapper testing. If host harness/API changes prevent a check, state that limitation. Do not turn a future source build into a claim of tested iOS runtime behavior.

On-device acceptance: import/load the reference model on CPU, generate multiple turns, retry, stop generation, background/reopen, reopen saved history, and test fullscreen entry/exit and settings navigation. Confirm model/chat data survive installation. Test Metal separately if investigating it; retain CPU default if it still fails. Inspect crash/Jetsam/native error logs where available. Record load latency, tokens/sec and memory only if actually measured. An engine update should be compared with the working baseline on the same device/model/settings.

## Full native build and installation

Every llama.cpp, wrapper, native dependency or native app change needs a **full native build**. `scripts/update-js-ipa.py` replaces only Hermes JavaScript bytecode and cannot bake in a new engine. Hermes runs the app's JavaScript; llama.cpp performs model inference.

Use macOS/Xcode or the manual [Build PocketPal 16 IPA workflow](https://github.com/dusklinux/pocketpal_16/actions/workflows/build-ios16.yml). Read the checked-in workflow for current runner/tool versions rather than guessing available versions. On macOS, install locked JavaScript dependencies and Bundler dependencies, then run `npm run build:ipa`. Output is `build/PocketPal16.ipa`. The build runs lint/types/tests, reinstalls Pods, builds Release arm64, verifies all packaged Mach-O minimum iOS versions, carries the two memory entitlements into ad-hoc signatures and packages the app. Keep these checks and entitlements; they do not guarantee unlimited RAM.

After an authorized push, dispatch the workflow on the intended branch and verify its exact head SHA, completion status and artifact. It also builds pushed `v*` tags; ordinary branch pushes do not start it. With authenticated `gh`, use `gh workflow run build-ios16.yml --ref main -f publish_release=false --repo dusklinux/pocketpal_16` for artifact-only verification. Publishing requires a unique higher version shared by the tag, package and updater. Never overwrite a published IPA under the same version. If API auth is unavailable, ask the user to use Actions → Build PocketPal 16 IPA → Run workflow → main. Git SSH push access does not imply authenticated Actions API access. Download the `PocketPal16` artifact from the successful run; build errors are in `ios-build-log`. A previous successful run took about seven minutes; this is an observation, not a guarantee.

Update checking uses `src/update-controller.ts` and `src/updater.ts`: first active launch, then every 48 hours while active or on reopening when due, with one-hour retries on failure. Its atomic state file is separate from chats. Installation is offered through TrollStore Lite and selects the full native IPA. This checks releases/upstream status; it never rebases or compiles upstream engine source on the phone. Keep engine metadata and the full build pin consistent when upgrading. There is no scheduled engine integration workflow; rebuilding a fixed patch cannot update it.

Install only when authorized. Use the supplied SSH endpoint or USB tunnel; discover the installed helper and data paths. The tested rootless helper is `/var/jb/Applications/TrollStoreLite.app/trollstorehelper`; rootful installations may use `/Applications/TrollStoreLite.app/trollstorehelper`. Upload the actual new IPA to a temporary device path, then invoke `trollstorehelper install /var/tmp/<uploaded-name>.ipa` and require exit status zero. TrollStore Lite re-signs the app. Delete the temporary upload afterward. Launch only if requested/appropriate using `uiopen --bundleid ai.pocketpal16`.

Preserve the bundle identifier, app data container, model files, `Library/pocketpal16.json`, settings and chats. Models are in the dynamically discovered `Documents/models` folder; never hardcode a container UUID. Model copying should use a `.partial` filename then rename after completion, with ownership/read access for `mobile`. Existing conversation model paths are rebased when a container UUID changes. Do not uninstall first or reset persistent data to fix an update.

USB SSH was tested via `iproxy 2222 22`, connecting to `root@127.0.0.1:2222`; this is an optional local tunnel, not a required/hardcoded deployment endpoint. Obtain credentials from the active session. Standard TrollStore support should not be confused with TrollStore Lite on this jailbroken iOS 16.7.x device.

## Report the result clearly

State the exact engine and bridge versions, the tracked adaptations, checks actually run, full build/run/artifact, device installation outcome and remaining limitations. Keep measured results separate from assumptions. Do not claim a newer backend is faster or fixes GPU loading without evidence. Review every changed diff before an authorized commit/push. Documentation-only changes do not require rebuilding the app.
