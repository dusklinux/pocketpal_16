# Contributing

Keep this fork focused on offline, text-only GGUF chat for iOS 16. Avoid restoring removed online services, marketplace features, voice/vision engines, or Android build dependencies.

Install dependencies using the locked Yarn 1 setup in README.md. Run `npm run typecheck`, `npm run lint`, and `npm test` for source changes. For native changes, regenerate CocoaPods on macOS, build the arm64 IPA, and test it on an iOS 16 device. Report the exact model, backend, OS, and observed logs; distinguish unit tests from actual device results.

The GitHub Actions workflow builds on manual dispatch or version tags and can publish a full native IPA release. Each published update needs a higher app version; engine source upgrades require the native integration and device checks in AGENTS.md. See README.md for the 48-hour update-check behavior, build and installation instructions.
