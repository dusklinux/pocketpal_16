#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $(uname -s) != Darwin ]]; then
  echo 'An iOS device build requires macOS with Xcode.' >&2
  exit 1
fi
xcodebuild -version
node --version
bundle exec pod --version
node scripts/prepare-backend.cjs
npm run lint
npm run typecheck
npm test
(cd ios && bundle exec pod deintegrate && bundle exec pod install)
mkdir -p build
xcodebuild \
  -workspace ios/PocketPal.xcworkspace \
  -scheme PocketPal -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath build/DerivedData \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  IPHONEOS_DEPLOYMENT_TARGET=16.0 \
  build 2>&1 | tee build/ios-build.log
app='build/DerivedData/Build/Products/Release-iphoneos/PocketPal.app'
[[ -f "$app/main.jsbundle" ]]
[[ $(xcrun lipo -archs "$app/PocketPal") == arm64 ]]
[[ $(/usr/libexec/PlistBuddy -c 'Print :MinimumOSVersion' "$app/Info.plist") == 16.0 ]]
# Reject any packaged Mach-O that requires a newer iOS runtime.
while IFS= read -r -d '' binary; do
  if file -b "$binary" | grep -q 'Mach-O'; then
    xcrun vtool -show-build "$binary" > build/macho-version.txt
    awk '/platform / {if ($2 != "IOS") exit 1}
         /minos / {found=1; if ($2 + 0 > 16) exit 1}
         END {if (!found) exit 1}' build/macho-version.txt
  fi
done < <(find "$app" -type f -print0)
# Ad-hoc signatures carry the memory entitlements into the jailbreak installer.
# Sign nested code first; no Apple developer account or certificate is used.
if [[ -d "$app/Frameworks" ]]; then
  while IFS= read -r -d '' binary; do
    codesign --force --sign - "$binary"
  done < <(find "$app/Frameworks" -type f -name '*.dylib' -print0)
  while IFS= read -r -d '' framework; do
    codesign --force --sign - "$framework"
  done < <(find "$app/Frameworks" -type d -name '*.framework' -depth -print0)
fi
codesign --force --sign - --entitlements ios/PocketPal/PocketPal.entitlements --generate-entitlement-der "$app"
codesign --verify --strict "$app"
# Package in a temporary directory; only replace the IPA after zip succeeds.
package_dir=$(mktemp -d "$PWD/build/package.XXXXXX")
trap 'rm -rf "$package_dir"' EXIT
mkdir "$package_dir/Payload"
ditto "$app" "$package_dir/Payload/PocketPal.app"
(cd "$package_dir" && /usr/bin/zip -q -r PocketPal16.ipa Payload)
mv "$package_dir/PocketPal16.ipa" build/PocketPal16.ipa
echo "Created $PWD/build/PocketPal16.ipa"
