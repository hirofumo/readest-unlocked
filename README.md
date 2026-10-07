# Readest Unlocked Build

English | [中文](README.zh-CN.md)

An automatically built **unlocked** build of [Readest](https://github.com/readest/readest), with the premium client gates removed, published to this repository's [Releases](https://github.com/hirofumo/readest-unlocked/releases).

This repository is a build recipe, not a source tree and not a fork. It contains no upstream code: every release is built from an exact upstream tag plus the patch scripts in `tools/`, and the complete diff against that tag ships with the release as `unlock.patch` — so what changed is always readable, and never taken on trust.

## Unlocked client features

All five features run through the same client-side entitlement check. These builds force that check open, so the features are available to every account — including a signed-out free one.

| Feature | What it means in the app |
| --- | --- |
| Third-party cloud sync | WebDAV, an S3-compatible bucket, Google Drive, OneDrive and iCloud Drive can be configured and used. |
| Per-chapter read-aloud (TTS) audio download | Read Aloud audio can be downloaded chapter by chapter for offline listening. |
| Audiobookshelf offline downloads | Audiobookshelf books and audiobooks can be stored on the device for offline use. |
| Trusted-device pairing | Nearby BookDrop transfers no longer ask for confirmation for each individual transfer. |
| Custom translators | Translation through your own OpenAI-compatible endpoint or your own DeepL key. |

## What is not unlocked

The service decides these server-side, from the account token. A client build cannot change that, and this project does not claim otherwise:

- Readest Cloud storage quota and upload limits
- the daily AI translation character quota
- the Send-to-Readest personal email address

One caveat on the last one. Its gate runs through the same client-side check this build opens, so the client half of that gate opens along with everything else: the Send-to-Readest panel asks the official server for an address and reports a load failure for an account the server refuses, where an unpatched build showed the upgrade card instead. The capability itself stays server-decided.

## Custom server URL

The Misc settings panel has a **Server URL** entry and an optional Supabase anon key. With both empty — the default — the app talks to the official Readest servers.

Setting the URL moves the whole backend to a self-hosted instance: the web/API origin, the Node API origin, the account backend, and the web links the app builds for exported annotations. The anon key is optional, and needed only when the self-hosted instance runs its own Supabase, whose keys differ from the official project's; leave it empty when the instance reuses the official project keys or runs no accounts at all. **Reset** clears both and returns to the official servers. Changing either reloads the app, because the API base and the Supabase client are resolved once at startup.

Not covered: the CDN hosts for webfonts and published covers, and the readest.com landing pages the web build links to. The desktop app reaches the former only for optional assets and copes without them.

## Release assets

`<V>` is the upstream version, for example `0.12.12`. Each release is tagged `v<V>-unlocked`, and every asset is named `Readest-<V>-<platform>-<arch or variant>-<type>.<ext>`:

```
Windows   x64 / arm64              installer + sig, portable zip
macOS     x64 / arm64              dmg, updater tarball + sig
Linux     x64 / arm64              AppImage + sig, deb, rpm
Android   replace / coexist        arm64-v8a, armeabi-v7a, x86_64, x86 (each + sig)
iOS       arm64                    unsigned ipa (sign it yourself)
```

| Platform | Assets |
| --- | --- |
| Windows | `Readest-<V>-windows-<arch>-setup.exe` and its `.sig`; `Readest-<V>-windows-<arch>-portable.zip` |
| macOS | `Readest-<V>-macos-<arch>.dmg`; `Readest-<V>-macos-<arch>-updater.tar.gz` and its `.sig` |
| Linux | `Readest-<V>-linux-<arch>.AppImage` and its `.sig`; `Readest-<V>-linux-<arch>.deb`; `Readest-<V>-linux-<arch>.rpm` |
| Android | `Readest-<V>-android-<family>-<abi>.apk` and its `.sig` |
| iOS | `Readest-<V>-ios-arm64.ipa` |

The Windows installer and the Linux AppImage are themselves the updater artifacts, which is why they carry signatures. The Windows portable zip does not update itself: the updater downloads whatever the manifest points at and launches it as an executable, so a zip cannot be that artifact. The iOS IPA is the second exception, for a different reason: the Tauri updater has no iOS support, so there is nothing to sign and nothing to point a manifest at. Every other platform still self-updates.

Every platform ships one build per architecture — there is no macOS universal build and no universal Android APK any more. Each Android ABI is published on its own so a download can be picked that matches the device.

### The two Android families

Both families install as **Readest**. The only difference is the application id.

| Family | Application id | Behaviour |
| --- | --- | --- |
| Replacing | `com.bilingify.readest` | The same identity the official app uses. Choose it when you are replacing the official app or never had it installed; a backup restored afterwards lands in the same place. The official app has to be removed first — see below. |
| Coexisting | `com.hirofumo.readest.unlocked` | Installs side by side with the official app, and starts with an empty library. |

The About dialog states which of the two is installed.

Both families are signed with the same self-generated Android key. That key is not upstream's, so the official app cannot be updated in place by either family, and neither family can be updated in place over the official app. Android rejects an install whose signature differs from the installed one, so an official install has to be removed first — which clears app-local data, unless it is restored from a backup — or the coexisting family is used instead.

On the desktop the position is different: those builds also keep upstream's identifier, so they read the same application data directory the official app used, and the library, settings and reading progress carry over without a re-import. That follows from the identifier being unchanged rather than from a separate test.

**Which APK, and what updates itself.** The four ABIs are published separately: `arm64-v8a` for current phones and tablets, `armeabi-v7a` for older 32-bit ARM devices, and `x86_64` / `x86` for emulators and x86 hardware. Each family is the same app under a different application id, so pick the family first and the ABI second. In-app updates work on every ABI: the app asks for the manifest key matching the device (`android-arm64`, `android-armv7`, `android-x86_64`, `android-x86`) and each manifest carries all four, each pointing at the package built for that ABI. That key mapping is part of this build's patch — an unpatched upstream build only knows `android-arm64` and `android-universal`, so on another ABI it would find nothing.

### The iOS build is unsigned

This repository has no Apple certificate, so the iOS asset is an honestly **unsigned** IPA: on its own it installs nothing. It is the app, archived for arm64 devices and packaged as `Payload/Readest.app`, and signing it is your side of the job — AltStore, SideStore, Sideloadly or Xcode, with your own Apple ID and provisioning profile.

What the resulting install can do depends on the account you sign with. App Groups are not available to free personal teams, and the reading widget and the share extension both rely on one, so expect those two to be degraded or missing unless you sign with a paid team. The package keeps upstream's bundle id `com.bilingify.readest`, so installing over an App Store copy of Readest requires removing that copy first.

**None of this has been verified on a device from CI.** What the build proves is that the package is structurally correct — see [How a release is verified](#how-a-release-is-verified) — not that it installs or runs. Treat the first device install as your own test.

## How releases are produced

Upstream is checked once a day. When it publishes a version that has no release here yet, that version is built for every platform below and published as `v<V>-unlocked`; a day without a new upstream version costs nothing but that check. A rebuild can also be triggered by hand, optionally pinned to a specific upstream tag, branch or commit.

Every release comes out of the same recipe: check the upstream tag out, apply the patch scripts in `tools/`, assert the patched sources, build, assert the built bundle, then read every package back before uploading it.

A patch that no longer fits upstream's code fails the build instead of being skipped: a silently still-locked build is the one outcome this project refuses to publish.

## Self-update

The app updates itself from this repository's releases, not from readest.com.

Each release publishes a signed updater manifest — `latest.json` for the replacing Android family and the desktop builds, `latest-coexist.json` for the coexisting Android family — together with the `.sig` files the Tauri updater verifies against a public key compiled into the app. The Windows portable zip and the iOS IPA are the exceptions described above and do not update themselves. The private signing key is held only in this repository's secrets and never ships in a build. Keep that private key and its password: because the matching public key is compiled into the app, losing them means no future release can be signed and already-installed apps will stop accepting updates.

## How a release is verified

Three checks stand between a patch and a published release, and none of them claims more than it measures:

1. **The patched sources.** Everything the patch asserts about the source tree is checked before anything is compiled, so a patch that no longer fits upstream's code fails in seconds rather than after a long build.
2. **The compiled bundle.** The JavaScript the app actually ships is searched for the `__READEST_UNLOCKED__` build marker — the difference between "the right file was edited" and "the released build is unlocked". The patched module also sets `globalThis.__READEST_UNLOCKED__ = true` at runtime, so an installed build can be checked the same way.
3. **The packages themselves.** Files are read, not trusted. Each Android APK has its application id, its ABIs and its signing certificate checked by unpacking it, and the iOS IPA has its bundle id, version, architecture, embedded app extensions and unsigned state checked the same way.

A failed check fails the build and produces no artifacts, so a half-patched release is never published.

## Verifying a download

Two independent things can be checked, and they answer different questions.

**The file arrived intact.** Every release publishes a `SHA256SUMS` file in
`shasum` format, so standard tooling reads it:

```bash
gh release download v0.12.12-unlocked --repo hirofumo/readest-unlocked --pattern SHA256SUMS
# download the one artifact you care about, then:
sha256sum -c SHA256SUMS --ignore-missing      # or: shasum -a 256 -c SHA256SUMS --ignore-missing
```

**The file was built here.** Every release also carries build provenance
attestations, signed by GitHub with a short-lived certificate tied to the
workflow run that produced the artifacts:

```bash
gh attestation verify Readest-0.12.12-windows-x64-setup.exe --repo hirofumo/readest-unlocked
```

Any asset works the same way, the Android APKs and the iOS IPA included. The
command fails unless the file came out of a workflow run in this repository, and
it reports which commit and which run produced it. What it does **not** claim is
that the code is harmless. For that, read the patch: every release also carries
`unlock.patch` — the complete diff against the upstream commit — and `BUILD.md`,
which names that upstream commit, the recipe commit, the build-time variables,
and how to check a download.

## Installing

The artifacts are not signed by a code-signing certificate.

- **Windows**: SmartScreen warns on first run. The installer updates itself; the portable zip does not.
- **macOS**: Gatekeeper blocks the first launch. Run `xattr -cr /Applications/Readest.app`, then open the app again.
- **Android**: see [the two families](#the-two-android-families) above before choosing an APK.
- **iOS**: the IPA is unsigned, so it has to be signed with your own Apple ID before it installs — see [the iOS build](#the-ios-build-is-unsigned) above, including what a free Apple ID cannot do.
- **Android, updating automatically**: the asset names are stable, so
  [Obtainium](https://github.com/ImranR98/Obtainium) can follow this repository
  directly — add `https://github.com/hirofumo/readest-unlocked` as a GitHub
  source and narrow it to the APK you installed, for example
  `Readest-[\d.]+-android-replace-arm64-v8a\.apk` or
  `Readest-[\d.]+-android-coexist-armeabi-v7a\.apk`. Pick the regex that matches
  the family and the ABI already on the device: the two families have different
  application ids and cannot update each other.

## Self-hosting

The **Server URL** entry in Settings points the client at your own Readest
instance. The server side is upstream's: [readest/docker](https://github.com/readest/readest/tree/main/docker)
ships a `compose.yaml` that brings up the app, the API and a Supabase stack, and
its README documents the environment variables.

Worth knowing before you pick a build: `SELF_HOSTED=true` is **upstream's own**
switch for this case, and their published image sets it by default — upstream
unlocks the premium client features for a self-hosted deployment, signed in or
not. This project applies the same rule to the desktop, Android and iOS builds,
which upstream does not publish; it does not invent a different one.

Pointing the client at your instance is the **Server URL** entry described under
[Custom server URL](#custom-server-url) above.

### Using it without an account at all

Nothing here requires a Readest account. With no signed-in user the app keeps a
local library, and syncing can go to WebDAV or an S3-compatible bucket — both are
third-party sync, so both are unlocked in this build. The account backend is only
needed for Readest Cloud, the Send-to-Readest address and shared annotations.

## License and compliance

Readest is licensed under **AGPL-3.0**, and so are this repository's scripts and the binaries published here. The full license text is in [LICENSE](LICENSE).

The AGPL asks anyone distributing a modified version to provide the Corresponding Source and to carry prominent notices that files were changed. This repository is that source: it holds the complete set of patch scripts and the exact build recipe. Every file the patches touch is marked in place with a `[readest-unlocked]` comment naming the change, except the three that are JSON and cannot hold one — `tauri.conf.json` and the two locale files. The About dialog carries the notice for those.

The published binaries keep upstream's copyright notices, license text and project identity. Nothing here removes or replaces them.

This project is not affiliated with, endorsed by or supported by Readest or Bilingify LLC. "Readest" and its logo belong to their owners and are used here only to describe what this build is derived from. Support for this build comes from this repository, not from upstream.

If this build is useful to you, upstream is the thing worth supporting: Readest is an actively developed reader with real infrastructure behind it, and its plans are what pay for that. Nothing here changes the deal for anyone using readest.com — the unlock applies only to builds from this repository, and the same features are already free to anyone running their own server. Bugs in reading, syncing or the reader UI belong in [upstream's tracker](https://github.com/readest/readest/issues); a problem with these builds themselves — a download that misbehaves, a release that failed — belongs here.

These builds are provided as-is, with no warranty, for personal use. You are responsible for complying with the licenses and terms of any third-party service the app talks to.

## What's in this repository

```
.github/workflows/   the release recipe and the daily check against upstream
tools/               the patch scripts, and the tooling that assembles a release
helpers/             small per-platform build helpers
LICENSE              AGPL-3.0
```

The patch scripts are the Corresponding Source for the binaries published here.
They are plain Node.js files with no build step of their own, and every change
they make to an upstream file is marked in place, so the recipe can be read
top to bottom without running anything.
