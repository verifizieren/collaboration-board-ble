#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="$ROOT/install/tremola-collaboration-board-debug.apk"
PACKAGE="nz.scuttlebutt.tremola"
ADB="${ADB:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb}"

if [ ! -x "$ADB" ]; then
  ADB="$(command -v adb 2>/dev/null || true)"
fi
if [ -z "$ADB" ] || [ ! -x "$ADB" ]; then
  echo "adb was not found. Install Android platform-tools or set ADB." >&2
  exit 1
fi

pick_device() {
  local requested="${1:-}" devices count
  if [ -n "$requested" ]; then
    if [ "$("$ADB" -s "$requested" get-state 2>/dev/null || true)" != "device" ]; then
      echo "Android device $requested is not ready." >&2
      exit 1
    fi
    printf '%s\n' "$requested"
    return
  fi

  devices="$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  count="$(printf '%s\n' "$devices" | awk 'NF { n++ } END { print n + 0 }')"
  if [ "$count" -eq 0 ]; then
    echo "No Android device found. Enable USB debugging and reconnect the phone." >&2
    exit 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "More than one device is connected. Add its serial number:" >&2
    echo "  ./scripts/android.sh install SERIAL" >&2
    "$ADB" devices -l >&2
    exit 1
  fi
  printf '%s\n' "$devices"
}

grant_ble_permissions() {
  local serial="$1" sdk permission
  sdk="$("$ADB" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')"
  for permission in android.permission.ACCESS_FINE_LOCATION; do
    "$ADB" -s "$serial" shell pm grant "$PACKAGE" "$permission" >/dev/null 2>&1 || true
  done
  if [ "$sdk" -ge 31 ] 2>/dev/null; then
    for permission in \
      android.permission.BLUETOOTH_SCAN \
      android.permission.BLUETOOTH_ADVERTISE \
      android.permission.BLUETOOTH_CONNECT
    do
      "$ADB" -s "$serial" shell pm grant "$PACKAGE" "$permission" >/dev/null 2>&1 || true
    done
  fi
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/android.sh devices
  ./scripts/android.sh install [SERIAL]
  ./scripts/android.sh launch [SERIAL]
  ./scripts/android.sh logs [SERIAL]
EOF
}

COMMAND="${1:-}"
SERIAL_ARG="${2:-}"

case "$COMMAND" in
  devices)
    "$ADB" devices -l
    ;;
  install)
    test -f "$APK" || { echo "APK missing. Run ./scripts/check.sh first." >&2; exit 1; }
    SERIAL="$(pick_device "$SERIAL_ARG")"
    if ! INSTALL_OUTPUT="$("$ADB" -s "$SERIAL" install -r "$APK" 2>&1)"; then
      echo "$INSTALL_OUTPUT" >&2
      if [[ "$INSTALL_OUTPUT" == *"INSTALL_FAILED_UPDATE_INCOMPATIBLE"* ]]; then
        echo "A Tremola app signed with another key is already installed." >&2
        echo "Back up its local data before uninstalling it, then run this command again." >&2
      fi
      exit 1
    fi
    echo "$INSTALL_OUTPUT"
    grant_ble_permissions "$SERIAL"
    "$ADB" -s "$SERIAL" shell am start -n "$PACKAGE/.MainActivity"
    echo "Installed on $SERIAL. Enable Bluetooth, then open Collaboration Board."
    ;;
  launch)
    SERIAL="$(pick_device "$SERIAL_ARG")"
    "$ADB" -s "$SERIAL" shell am start -n "$PACKAGE/.MainActivity"
    ;;
  logs)
    SERIAL="$(pick_device "$SERIAL_ARG")"
    echo "Showing BLE and whiteboard logs from $SERIAL. Press Ctrl-C to stop."
    exec "$ADB" -s "$SERIAL" logcat -v color \
      BleSync:D FrontendRequest:D CMD:D AndroidRuntime:E '*:S'
    ;;
  *)
    usage
    exit 1
    ;;
esac
