# Contributing

Keep this fork focused on offline, text-only GGUF chat for iOS 16. Avoid restoring removed online services, marketplace features, voice/vision engines, or Android build dependencies.

Install dependencies using the locked Yarn 1 setup in README.md. Run `npm run typecheck`, `npm run lint`, and `npm test` for source changes. For native changes, regenerate CocoaPods on macOS, build the arm64 IPA, and test it on an iOS 16 device. Report the exact model, backend, OS, and observed logs; distinguish unit tests from actual device results.

The manual GitHub Actions workflow builds an artifact after source is uploaded. It does not publish a release. See README.md for build, installation, and model import instructions.
