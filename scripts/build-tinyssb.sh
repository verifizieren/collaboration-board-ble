#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PINNED_COMMIT="39896b72c97b51159d46610c5f11ff7f5a279031"
DEFAULT_SOURCE="$ROOT/../tinyssb-upstream/ssbc-tinyssb"
SOURCE="${TINYSSB_SOURCE:-$DEFAULT_SOURCE}"
BUILD_ROOT="$ROOT/.build/tinyssb"
ANDROID_PROJECT="$BUILD_ROOT/android/tinySSB"
WEB_DIR="$ANDROID_PROJECT/app/src/main/assets/web"
OUTPUT="$ROOT/install/tinyssb-collaboration-board-debug.apk"
NAMED_OUTPUT="$ROOT/install/tinyssb/whiteboard.apk"

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"

if [ -z "$NODE_BIN" ] && [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "Android Studio's Java runtime was not found at $JAVA_HOME." >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME" ]; then
  echo "Android SDK was not found at $ANDROID_HOME." >&2
  exit 1
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Node.js was not found. Install Node.js or set NODE_BIN." >&2
  exit 1
fi

CMAKE_BIN="$ANDROID_HOME/cmake/3.18.1/bin"
if [ ! -x "$CMAKE_BIN/cmake" ] || [ ! -x "$CMAKE_BIN/ninja" ]; then
  echo "Android SDK CMake 3.18.1 and Ninja are required." >&2
  echo "Install the SDK package cmake;3.18.1 in Android Studio." >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME/ndk/25.0.8775105" ]; then
  echo "Android NDK 25.0.8775105 is required." >&2
  echo "Install the SDK package ndk;25.0.8775105 in Android Studio." >&2
  exit 1
fi

if [ ! -d "$SOURCE/.git" ]; then
  SOURCE="https://github.com/ssbc/tinyssb.git"
fi

echo "[1/5] Preparing official tinySSB source"
rm -rf "$BUILD_ROOT"
git clone --quiet "$SOURCE" "$BUILD_ROOT"
git -C "$BUILD_ROOT" checkout --quiet "$PINNED_COMMIT"
git -C "$BUILD_ROOT" apply "$ROOT/tinyssb/integration.patch"
git -C "$BUILD_ROOT" apply "$ROOT/tinyssb/ble-startup.patch"

echo "[2/5] Adding Collaboration Board"
mkdir -p "$WEB_DIR/prod/whiteboard"
cp "$ROOT/miniApps/collabboard/resources/board.css" "$WEB_DIR/prod/whiteboard/board.css"
cp "$ROOT/miniApps/collabboard/src/collabboard.js" "$WEB_DIR/prod/whiteboard/collabboard.js"
cp "$ROOT/tinyssb/whiteboard/adapter.js" "$WEB_DIR/prod/whiteboard/adapter.js"
cp "$ROOT/tinyssb/whiteboard/theme.css" "$WEB_DIR/prod/whiteboard/theme.css"
cp "$ROOT/tinyssb/whiteboard/whiteboard.svg" "$WEB_DIR/prod/whiteboard/whiteboard.svg"
"$NODE_BIN" "$ROOT/tinyssb/prepare-tinyssb.js" "$WEB_DIR"

echo "[3/5] Checking JavaScript"
"$NODE_BIN" --check "$WEB_DIR/prod/whiteboard/collabboard.js"
"$NODE_BIN" --check "$WEB_DIR/prod/whiteboard/adapter.js"
"$NODE_BIN" "$ROOT/tests/tinyssb-whiteboard.test.js"

echo "[4/5] Building tinySSB APK"
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME" JAVA_HOME
env PATH="$CMAKE_BIN:$PATH" "$ANDROID_PROJECT/gradlew" \
  --no-daemon -p "$ANDROID_PROJECT" assembleDebug

echo "[5/5] Preparing and verifying APK"
mkdir -p "$ROOT/install/tinyssb"
cp "$ANDROID_PROJECT/app/build/outputs/apk/debug/app-debug.apk" "$OUTPUT"
cp "$OUTPUT" "$NAMED_OUTPUT"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
unzip -p "$OUTPUT" assets/web/prod/whiteboard/collabboard.js > "$TMP_DIR/collabboard.js"
unzip -p "$OUTPUT" assets/web/prod/whiteboard/adapter.js > "$TMP_DIR/adapter.js"
unzip -p "$OUTPUT" assets/web/prod/whiteboard/theme.css > "$TMP_DIR/theme.css"
unzip -p "$OUTPUT" assets/web/tremola.js > "$TMP_DIR/tremola.js"
unzip -p "$OUTPUT" assets/web/tremola_ui.js > "$TMP_DIR/tremola_ui.js"
cmp -s "$ROOT/miniApps/collabboard/src/collabboard.js" "$TMP_DIR/collabboard.js"
cmp -s "$ROOT/tinyssb/whiteboard/adapter.js" "$TMP_DIR/adapter.js"
cmp -s "$ROOT/tinyssb/whiteboard/theme.css" "$TMP_DIR/theme.css"
grep -Fq "['Invitations', 'whiteboard_show_invitations']" "$TMP_DIR/tremola_ui.js"
grep -Fq "whiteboard_invite_contacts();" "$TMP_DIR/tremola_ui.js"
grep -Fq 'else if (e.public[0] == "WBD")' "$TMP_DIR/tremola.js"
cmp -s "$OUTPUT" "$NAMED_OUTPUT"

BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
if [ -x "$BUILD_TOOLS/apksigner" ]; then
  "$BUILD_TOOLS/apksigner" verify --verbose "$OUTPUT"
fi
if [ -x "$BUILD_TOOLS/aapt" ]; then
  "$BUILD_TOOLS/aapt" dump badging "$OUTPUT" \
    | grep -E "^(package:|sdkVersion:|targetSdkVersion:)"
fi

(
  cd "$ROOT/install"
  APK_FILES=(tremola-collaboration-board-debug.apk whiteboardlive.apk whiteboard5sek.apk tremola/whiteboard.apk tinyssb-collaboration-board-debug.apk tinyssb/whiteboard.apk)
  shasum -a 256 "${APK_FILES[@]}" > SHA256SUMS
)

echo
echo "Ready: $OUTPUT"
echo "Named: $NAMED_OUTPUT"
shasum -a 256 "$OUTPUT"
