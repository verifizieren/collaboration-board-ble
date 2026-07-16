#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find_java_11() {
  local candidate first_line
  for candidate in \
    "${JAVA_HOME:-}" \
    "/opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home" \
    "/usr/local/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home"
  do
    if [ -n "$candidate" ] && [ -x "$candidate/bin/java" ]; then
      first_line="$("$candidate/bin/java" -version 2>&1 | head -n 1)"
      if [[ "$first_line" == *'"11.'* ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

JAVA_HOME="$(find_java_11 || true)"
if [ -z "$JAVA_HOME" ]; then
  echo "JDK 11 was not found. Install openjdk@11 or set JAVA_HOME." >&2
  exit 1
fi
export JAVA_HOME

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [ ! -d "$ANDROID_HOME" ]; then
  echo "Android SDK was not found at $ANDROID_HOME." >&2
  exit 1
fi
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Node.js was not found. Install Node.js or set NODE_BIN." >&2
  exit 1
fi

echo "[1/6] Checking the Android mini-app copy"
for path in \
  assets/board.svg \
  manifest.json \
  resources/board.css \
  resources/board.html \
  src/collabboard.js
do
  if ! cmp -s "miniApps/collabboard/$path" "app/src/main/assets/web/miniApps/collabboard/$path"; then
    echo "Mini-app copy differs: $path" >&2
    exit 1
  fi
done

echo "[2/6] Running JavaScript and board checks"
bash -n scripts/check.sh scripts/android.sh scripts/build-tinyssb.sh
sh -n start.sh
for file in \
  src/*.js \
  miniApps/collabboard/src/*.js \
  app/src/main/assets/web/*.js \
  app/src/main/assets/web/miniApps/collabboard/src/*.js
do
  "$NODE_BIN" --check "$file"
done
"$NODE_BIN" tests/collabboard.test.js

echo "[3/6] Running Android unit tests, lint, and build"
./gradlew --no-daemon clean testDebugUnitTest lintDebug assembleDebug

echo "[4/6] Running Android device tests when available"
ADB="$ANDROID_HOME/platform-tools/adb"
if [ -x "$ADB" ] && "$ADB" devices | awk 'NR > 1 && $2 == "device" { found = 1 } END { exit !found }'; then
  ./gradlew --no-daemon connectedDebugAndroidTest
else
  echo "No Android phone or emulator attached; device tests skipped."
fi

echo "[5/6] Preparing the install APK"
APK="app/build/outputs/apk/debug/app-debug.apk"
INSTALL_APK="install/tremola/whiteboard.apk"
test -f "$APK"
mkdir -p install/tremola
cp "$APK" "$INSTALL_APK"
rm -f install/tremola-collaboration-board-debug.apk \
  install/whiteboardlive.apk \
  install/whiteboard5sek.apk
(
  cd install
  APK_FILES=(tremola/whiteboard.apk)
  if [ -f tinyssb/whiteboard.apk ]; then
    APK_FILES+=(tinyssb/whiteboard.apk)
  fi
  shasum -a 256 "${APK_FILES[@]}" > SHA256SUMS
)

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
unzip -p "$INSTALL_APK" assets/web/miniApps/collabboard/src/collabboard.js \
  > "$TMP_DIR/collabboard.js"
cmp -s miniApps/collabboard/src/collabboard.js "$TMP_DIR/collabboard.js"

echo "[6/6] Verifying the APK"
BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
if [ -x "$BUILD_TOOLS/apksigner" ]; then
  "$BUILD_TOOLS/apksigner" verify --verbose "$INSTALL_APK"
fi
if [ -x "$BUILD_TOOLS/aapt" ]; then
  "$BUILD_TOOLS/aapt" dump badging "$INSTALL_APK" \
    | grep -E "^(package:|sdkVersion:|targetSdkVersion:)"
fi

echo
echo "Ready: $ROOT/$INSTALL_APK"
cat install/SHA256SUMS
