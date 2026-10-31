/**
 * The release asset contract: exactly which files this recipe publishes.
 *
 * This lives in one module because two callers ask the same question from
 * opposite ends of a run, and a second copy of the list would drift:
 *
 *   resolve-upstream.mjs    "is the existing release complete?" — a release
 *                           missing an asset gets rebuilt. Runs in `detect`,
 *                           before any leg.
 *   check-release-assets.mjs "does the release hold exactly this set?" —
 *                           unexpected assets are fatal (they are leftovers,
 *                           since `--clobber` never removes), missing ones are
 *                           reported. Runs in `manifest`, before anything new
 *                           is stamped over the release.
 *
 * Before this module existed, only the second caller knew the list, and the
 * first decided "already built" from a single prefix match — so a release that
 * had lost one platform looked complete forever. That is exactly what happened
 * on 2026-10-31: the NightlyBuild release held 41 of its 42 assets, no IPA, and
 * `detect` kept answering "already carries <sha>; nothing to do". Recovering
 * took a manual `force=true`.
 *
 * Changing a product name, or adding/removing a platform, means changing this
 * file — and that is the point: the list is the contract, not a derivation from
 * whatever the release happens to hold. A derivation could never notice a
 * leftover.
 */

const WINDOWS_ARCHES = ['x64', 'arm64'];
const MACOS_VARIANTS = ['x64', 'arm64'];
const LINUX_ARCHES = ['x64', 'arm64'];
const ANDROID_FAMILIES = ['replace', 'coexist'];
// The ABI directory names inside the APK, which is also what the asset names and
// the workflow's variant names use. The CLI's target names differ for one of
// them: `-t i686` builds the x86 package.
const ANDROID_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];

/**
 * The asset names a release of this shape must hold.
 *
 * @param {object} options
 * @param {'release'|'nightly'} options.mode
 * @param {string} options.prefix asset prefix, e.g. `Readest-0.12.16`
 * @param {boolean} [options.android] whether the Android family is part of this
 *   build. A fork without the signing secret never runs those legs, so expecting
 *   their assets would make every run look incomplete and rebuild forever.
 * @returns {Set<string>}
 */
export function expectedAssets({ mode, prefix, android = true }) {
  const expected = new Set();
  const add = (...names) => names.forEach((name) => expected.add(name));

  for (const arch of WINDOWS_ARCHES) {
    // The installer is the updater artifact, so it is signed; the portable build
    // is a zip and carries no signature.
    add(`${prefix}-windows-${arch}-setup.exe`, `${prefix}-windows-${arch}-setup.exe.sig`);
    add(`${prefix}-windows-${arch}-portable.zip`);
  }
  for (const variant of MACOS_VARIANTS) {
    // The dmg is for humans; the updater artifact is the .app tarball.
    add(`${prefix}-macos-${variant}.dmg`);
    add(`${prefix}-macos-${variant}-updater.tar.gz`, `${prefix}-macos-${variant}-updater.tar.gz.sig`);
  }
  for (const arch of LINUX_ARCHES) {
    // The AppImage is itself the updater artifact, so it is signed in place.
    add(`${prefix}-linux-${arch}.AppImage`, `${prefix}-linux-${arch}.AppImage.sig`);
    add(`${prefix}-linux-${arch}.deb`, `${prefix}-linux-${arch}.rpm`);
  }
  if (android) {
    for (const family of ANDROID_FAMILIES) {
      for (const abi of ANDROID_ABIS) {
        add(`${prefix}-android-${family}-${abi}.apk`, `${prefix}-android-${family}-${abi}.apk.sig`);
      }
    }
  }
  // iOS: unsigned on purpose, and not an updater target, so no .sig.
  add(`${prefix}-ios-arm64.ipa`);

  // The release's own documents, written by the pipeline rather than by a leg.
  add('SHA256SUMS', 'unlock.patch', 'BUILD.md');
  if (mode === 'nightly') {
    add('nightly.json', 'nightly-coexist.json');
  } else {
    add('latest.json', 'latest-coexist.json', 'release-notes.json');
  }

  return expected;
}

/** The contract entries a release does not hold, sorted. */
export function missingAssets({ mode, prefix, android = true, actual }) {
  const present = actual instanceof Set ? actual : new Set(actual);
  return [...expectedAssets({ mode, prefix, android })].filter((name) => !present.has(name)).sort();
}
