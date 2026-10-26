# PocketPal 16

For future AI maintenance, see [AGENTS.md](AGENTS.md) for the complete llama.cpp update procedure, patch regeneration, known iOS build fixes, verification, and full IPA installation.

A minimal, offline, text-only fork of [PocketPal AI](https://github.com/a-ghorbani/pocketpal-ai) for jailbroken iOS 16 devices. The native IPA built successfully and was installed on a jailbroken iPhone 8 Plus running iOS 16.7.16. LFM2.5 Q4_K_M loaded and generated text on CPU. Metal loading failed on that device; memory use and tokens/sec have not been measured.

Keeps local GGUF chat, Files import, SSH model copying, saved conversations, selectable responses, a system prompt, basic generation settings, and persistent system/light/dark appearance. Uses React Native 0.87.1 and `llama.rn` 0.13.0-rc.7 with a reproducible source patch to [llama.cpp c83f3058b6f876f2f7e6ccbada858b2446860c85](https://github.com/ggml-org/llama.cpp/commit/c83f3058b6f876f2f7e6ccbada858b2446860c85), upstream master verified on October 11, 2026. `scripts/prepare-backend.cjs` applies the pinned patch during dependency installation and regenerates embedded Metal kernels. Text completion uses the GGUF template and raw output; structured tool/reasoning parsing is omitted. The engine builds from source for iOS 16.0, with CPU and Metal enabled. A newer engine supports its implemented architectures; GGUF files for unsupported architectures will still fail to load.

Removed Pals/PalsHub, purchases, accounts, Firebase, Supabase, Hugging Face browsing/downloads, voice/TTS/ONNX, cameras, image input, tool execution, search, remote servers, benchmarks, leaderboard submission, Siri/Shortcuts, onboarding, Android builds, bundled custom fonts, rich HTML/Markdown rendering, and associated source/tests/workflows. Messages display as selectable plain text.

## Build

Requires macOS, Xcode 16.1 or newer with an iPhoneOS SDK, Node 22.21.0 or newer, Ruby/Bundler, and CocoaPods 1.17.0. The workflow uses Node 24.21.0, Ruby 4.0.7, and a macOS 26 runner. Linux cannot build this React Native iOS app with the standard Xcode workflow.

```sh
RNLLAMA_SKIP_POSTINSTALL=1 npx --yes yarn@1.22.22 install --frozen-lockfile
bundle install
npm run lint
npm run build:ipa
```

Output: `build/PocketPal16.ipa`. The script builds a release arm64 device app, checks its deployment target and bundled Mach-O minimum versions, adds ad-hoc signatures and the two retained memory entitlements, and packages an IPA. No Apple developer account is needed for this build; installation requires your jailbreak app installer.

The GitHub Actions workflow, `.github/workflows/build-ios16.yml`, builds on manual dispatch or a pushed `v*` tag. Manual runs can disable `publish_release` for artifact-only verification. Publication creates a release containing the full native `PocketPal16.ipa` and its source/engine identity; existing releases are never overwritten. The tag, package version, native bundle version and updater version must agree. Bump the app version for every published update, including engine changes. Changes to this workflow take effect after publication to GitHub; local edits do not change the remote workflow.

## Automatic update checks

The app checks GitHub for a newer full native IPA release and llama.cpp upstream status on first launch, then every **48 hours while active**. When suspended or closed, it checks when next opened after the saved due time. It does not run a background daemon or promise checks while iOS has suspended it. Failures retry after one hour; Settings also offers an immediate manual check. The repository, due time and last result are saved separately from chats/models in `Library/pocketpal16-updates.json`.

A newer app release shows an offer leading to Settings → Update (TrollStore). Installation remains manual through TrollStore Lite. Chat/model inference stays offline; only update checks contact GitHub. The full native `PocketPal16.ipa` is selected even if a JavaScript-only IPA is listed first. Network/API errors do not mean the app is up to date.

**This does not automatically integrate upstream llama.cpp source.** The engine is compiled into the IPA and remains pinned until a maintainer rebases the bridge patch, builds a new native IPA and publishes a higher app version. Upstream commit counts are informational; they do not mean an installable engine update exists or has passed iPhone testing. Rebuilding the same pinned source on a timer cannot upgrade the engine, so the former weekly rebuild/overwrite schedule has been removed. Follow AGENTS.md for native engine upgrades.

On October 26, 2026, updater verification passed 48 JavaScript tests, lint, type checking, release Metro/Hermes bundling and actionlint validation. The JS update was installed through USB SSH/TrollStore Lite on the iPhone 8 Plus running iOS 16.7.16. Real GitHub checks succeeded, the saved interval was exactly 172800000 ms, reopening before the due time reused the result, and an expired due time triggered a fresh check on reopening. The 48-hour active timer and failure retries were tested with a simulated clock, not a two-day device soak. Every IPA member except `main.jsbundle` matched the native base; engine inference was not retested. Workflow validation was local; no new native CI build was run for these updater changes.

The previous CocoaPods lockfile was removed because it described the discarded app. The first macOS build resolves the reduced Podfile; retain and review its new `ios/Podfile.lock` after a successful build. The JavaScript dependency lockfile has been regenerated and is checked during installation.

## Fast updates to JavaScript and settings

For UI or JavaScript-only changes, use a working IPA built with the same React Native version, native code, native dependencies, engine patch, and build settings as this checkout. Native changes still require the full Xcode/GitHub Actions build. Install the locked JavaScript dependencies first. The helper requires Python 3.15+, Node, and SSH/SCP for optional installation; it runs on Linux or macOS.

```sh
npm run update:ipa -- --base-ipa /path/to/working.ipa
```

This runs lint, type checking, and tests, creates a release bundle, compiles it with the checkout's Hermes compiler, checks the bytecode version against the base IPA, and writes `build/PocketPal16-js.ipa`. It preserves the base IPA and all archive members except `main.jsbundle`. Changes that emit bundled assets require the full build. Matching bytecode versions do not prove compatibility with changed native dependencies; keep the native base unchanged.

To install the result through TrollStore Lite over SSH:

```sh
npm run update:ipa -- --base-ipa /path/to/working.ipa --install-host root@127.0.0.1 --ssh-port 2222
```

Use your actual SSH host and port. SSH handles authentication normally; no password is stored in the script. The helper discovers the rootful/rootless TrollStore Lite executable, uploads to a temporary device file, invokes its installer, and cleans up the upload and connection. TrollStore Lite re-signs the updated app; this repacked IPA requires that installation route. Existing conversations, model files, and settings remain in the app's data container. Reopen the app and load your model after installation.

## Installation

Open the resulting IPA with TrollStore Lite on your jailbroken device. The inspected device runs iOS 16.7.16 and has TrollStore Lite 2.1.1 installed. This is a jailbreak-dependent installation route: standard TrollStore does not support released iOS 16.7.x. Do not assume this app stays launchable after booting without the jailbreak. See [TrollStore Lite](https://havoc.app/package/trollstorelite) and [TrollStore support](https://github.com/opa334/TrollStore).

The bundle identifier is `ai.pocketpal16`, separate from the original app. This preserves the original app and its data. Old PocketPal conversations are not migrated to the new storage format.

## Models and chat

- Tap Models → Import GGUF, choose a file in Files, then tap Load. Existing filenames are preserved; duplicate imports receive numbered names. Imports copy through a `.partial` file and verify the GGUF magic before appearing in the list.
- For SSH copying, open Models and copy the displayed folder path. It is discovered from the app's actual Documents directory; no container UUID or username is hardcoded. Copy as `filename.partial`, then rename to `filename.gguf` after transfer completes and tap Refresh. Set ownership so the app's `mobile` user can read the file. Files also exposes the app's Documents folder.
- Start with a quantized model around 1B parameters and the default **1024-token context / 256-token output**. Actual fit depends on architecture, quantization, KV/state memory, and iOS's process limit. The retained memory entitlements do not guarantee access to all physical RAM.
- CPU is the default; Metal is an explicit Settings option. The inspected iPhone 8 Plus loaded and generated text with LFM2.5 Q4_K_M on CPU; Metal loading failed on that device. The status reports the backend returned by llama.rn. No hardware-specific CPU compiler flags are set.
- Context size or backend changes unload the current model. Load it again to apply them. Only one model and one generation run at a time. Automatic model loading at startup is disabled.
- History saves before and after generation, and on backgrounding. Going into the background requests cancellation and saves the partial response. Abrupt termination during generation can lose tokens generated since the last checkpoint.
- When a conversation exceeds context, the app removes its oldest complete turns from the inference prompt while preserving the saved history. Oversized current input/system prompts show an error rather than silently truncating them.
- Retry last response regenerates the latest turn and also recovers a response interrupted by process termination. A failed retry without output preserves the prior response.
- Conversations remember their model path, rebased to the current Documents/models directory if an app update changes the data-container UUID. Load that model or start a new chat when changing models. Model chat templates come from GGUF metadata; no architecture-specific prompt format is hardcoded. Thinking is disabled where the template supports it, but models that always emit reasoning can still show it as plain text.

Chat offers a Fullscreen button beside New chat. Fullscreen hides the status bar, navigation, model status, and conversation header. Its composer keeps an exit-fullscreen arrow, Retry, and Send/Stop controls. Exit fullscreen to reach navigation and New chat. Chat messages remain selectable; per-message Copy buttons are removed. The model folder still has Copy folder path for SSH transfers.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npx react-native bundle --platform ios --dev false --entry-file index.js --bundle-output /tmp/pocketpal16.jsbundle
```

The Linux review passed 28 JavaScript tests, type checking, lint, release Metro bundling, nine native wrapper tests, and syntax checks of the wrapper JSI sources against React Native 0.87.1 headers. All generated Metal embedding assembly files assembled for arm64 iOS; this does not compile or exercise the Metal shaders. The patched native sources used for CPU testing were compared with installed package sources.

The downloaded `LFM2.5-1.2B-Instruct-Q4_K_M.gguf` (698 MiB) loaded with a 1024-token context and generated “2 plus 2 equals 4.” using the native wrapper on Linux CPU. This confirms architecture support for that file, not iPhone speed or memory fit. Model files are not included in this repository.

Tests cover context budgeting, persistence validation/order/failure recovery, generation cancellation, model lifecycle, model import failure cleanup, and avoiding cross-model conversation reuse. Native modules are mocked in unit tests; these tests do not establish device compatibility.

Before calling a release usable, build the IPA, install it, import a real GGUF, test both CPU and Metal, stop a response, background the app, reopen a saved conversation, and inspect device logs for crashes or memory termination. Measure tokens/sec and memory on the actual device; source size/dependency reductions do not establish inference speed improvements.

Runtime dependencies are reduced to six. React 19.2.3 matches the React Native renderer; Babel 7 and TypeScript 6 follow the supported toolchain ranges. Newer incompatible major versions are deliberately excluded. The macOS workflow builds the native IPA. Further native engine changes require another build and device validation.

MIT license inherited from PocketPal AI; see [LICENSE](LICENSE).
