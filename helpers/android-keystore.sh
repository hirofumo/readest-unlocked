#!/usr/bin/env bash
#
# Writes the Android signing configuration into a freshly generated Gradle
# project.
#
# `tauri android init` regenerates src-tauri/gen/android from scratch, so the
# keystore wiring has to be re-applied after every init — and the Android job
# runs init twice (once per application id). The keystore itself is never stored
# in the repository: it arrives base64-encoded in a secret and is decoded into
# $RUNNER_TEMP, which the runner discards afterwards.
#
# Run from the workspace root, after `tauri android init`.
set -euo pipefail

: "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS is not set}"
: "${ANDROID_KEY_PASSWORD:?ANDROID_KEY_PASSWORD is not set}"
: "${ANDROID_KEY_BASE64:?ANDROID_KEY_BASE64 is not set}"
: "${RUNNER_TEMP:?RUNNER_TEMP is not set (this helper is meant for CI)}"

gen=apps/readest-app/src-tauri/gen/android
if [ ! -d "$gen" ]; then
  echo "android-keystore: no generated project at $gen; run 'tauri android init' first" >&2
  exit 1
fi

keystore="$RUNNER_TEMP/keystore.jks"
# `base64 -d` rejects an empty stream, and a silently empty keystore would only
# surface as an opaque Gradle failure much later.
printf '%s' "$ANDROID_KEY_BASE64" | base64 -d > "$keystore"
if [ ! -s "$keystore" ]; then
  echo "android-keystore: decoded keystore is empty; is ANDROID_KEY_BASE64 valid base64?" >&2
  exit 1
fi

cat > "$gen/keystore.properties" <<EOF
keyAlias=$ANDROID_KEY_ALIAS
password=$ANDROID_KEY_PASSWORD
storeFile=$keystore
EOF

echo "android-keystore: wrote $gen/keystore.properties (keystore at $keystore)"
