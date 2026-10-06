# Readest Unlocked Build

[中文文档](README.zh-CN.md)

An automatically built **unlocked** build of [Readest](https://github.com/readest/readest), with the premium client gates removed, published to this repository's Releases.

This repository is a build recipe, not a source tree. It contains no upstream code: every CI run checks the upstream tag out, applies the patch scripts in `tools/`, verifies the result, builds, and uploads the installers here. Upstream can rewrite anything it likes without creating a merge conflict for anyone.

## Unlocked client features

All five features below are routed through a single entitlement helper, `isCustomizationAllowed()` in `apps/readest-app/src/utils/access.ts`. The build patch forces that helper to return `true`, so the gates open for every account, including a signed-out free one.

| Feature | What it means in the app |
| --- | --- |
| Third-party cloud sync | WebDAV, an S3-compatible bucket, Google Drive, OneDrive and iCloud Drive can be configured and used. |
| Per-chapter read-aloud (TTS) audio download | Read Aloud audio can be downloaded chapter by chapter for offline listening. |
| Audiobookshelf offline downloads | Audiobookshelf books and audiobooks can be stored on the device for offline use. |
| Trusted-device pairing | Nearby BookDrop transfers no longer ask for confirmation for each individual transfer. |
| Custom translators | Translation through your own OpenAI-compatible endpoint or your own DeepL key. |

## What is not unlocked

These are decided by the upstream service, server-side, from the account token. A client build cannot change them, and this project does not claim otherwise:

- Readest Cloud storage quota and upload limits
- the daily AI translation character quota
- the Send-to-Readest personal email address

## Custom server URL

The Misc settings panel has a **Server URL** entry. Left empty, which is the default, the app uses the official Readest servers. Setting it points the app's API and account backend at a self-hosted instance.

One limitation, stated plainly: this repository builds against upstream, so the compiled-in Supabase anon key still comes from the official build. An account on a self-hosted Supabase may therefore need that server to accept the official anon key.

## Release assets

`<V>` is the upstream version, for example `0.12.12`. Each release is tagged `v<V>-unlocked`, and every asset is named `Readest-<V>-<platform>-<arch or variant>-<type>.<ext>`:

```
Windows   x64 / arm64              installer + sig, portable zip
macOS     x64 / arm64 / universal  dmg, updater tarball + sig
Linux     x64 / arm64              AppImage + sig, deb, rpm
Android   replace / coexist        arm64-v8a, armeabi-v7a, universal (each + sig)
```

| Platform | Assets |
| --- | --- |
| Windows | `Readest-<V>-windows-<arch>-setup.exe` and its `.sig`; `Readest-<V>-windows-<arch>-portable.zip` |
| macOS | `Readest-<V>-macos-<variant>.dmg`; `Readest-<V>-macos-<variant>-updater.tar.gz` and its `.sig` |
| Linux | `Readest-<V>-linux-<arch>.AppImage` and its `.sig`; `Readest-<V>-linux-<arch>.deb`; `Readest-<V>-linux-<arch>.rpm` |
| Android | `Readest-<V>-android-<family>-<abi>.apk` and its `.sig` |

The Windows installer and the Linux AppImage are themselves the updater artifacts, which is why they carry signatures. The Windows portable zip does not update itself: the updater downloads whatever the manifest points at and launches it as an executable, so a zip cannot be that artifact. Every other platform still self-updates.

### The two Android families

Both families install as **Readest**. The only difference is the application id.

| Family | Application id | Behaviour |
| --- | --- | --- |
| Replacing | `com.bilingify.readest` | The same identity the official app uses. Choose it when you are replacing the official app or never had it installed; a backup restored afterwards lands in the same place. The official app has to be removed first — see below. |
| Coexisting | `com.hirofumo.readest.unlocked` | Installs side by side with the official app, and starts with an empty library. |

The About dialog states which of the two is installed.

Both families are signed with the same self-generated Android key. That key is not upstream's, so the official app cannot be updated in place by either family, and neither family can be updated in place over the official app. Android rejects an install whose signature differs from the installed one, so an official install has to be removed first — which clears app-local data, unless it is restored from a backup — or the coexisting family is used instead.

On the desktop the position is different: those builds also keep upstream's identifier, so they read the same application data directory the official app used, and the library, settings and reading progress carry over without a re-import. That follows from the identifier being unchanged rather than from a separate test.

## How the pipeline works

Triggers:

| Trigger | Detail |
| --- | --- |
| Schedule | Daily at 03:00 UTC. A day without a new upstream version costs one cheap `detect` job and nothing else. |
| `workflow_dispatch` | Inputs `ref` (upstream tag, branch or sha; empty means the latest upstream release tag) and `force` (rebuild even when a release for this version already exists). |

Jobs:

| Job | Purpose |
| --- | --- |
| detect | Resolves which upstream version to build, and skips the whole run when a release for that version already exists. |
| prepare | Creates the release, so the build legs only have to upload assets. |
| build | A matrix over Windows (`x64`, `arm64`), macOS (`x64`, `arm64`, `universal`) and Linux (`x64`, `arm64`). |
| build_android | A separate job, because a job-level `if` cannot read the matrix context and Android has to be skipped outright when the signing secrets are not configured. |
| manifest | Publishes `latest.json` and `latest-coexist.json`, assembled from the `.sig` files every leg uploaded, plus upstream's `release-notes.json` for the in-app "recent updates" view. |
| summary | Reports the result of every leg. |

Every leg does the same thing: check upstream out at the resolved ref, run `tools/unlock.mjs`, assert the patched sources, build, assert the built bundle, upload its assets.

Patching is anchor-based and deliberately fails the build when an anchor moves. Shipping a silently still-locked build is the one outcome that must never happen, so a missing or ambiguous anchor is a hard failure rather than a warning. Two purely cosmetic patches are the exception: they are best-effort and only warn, because refusing to ship a working build over a stray badge would be the wrong trade.

## Self-update

The app updates itself from this repository's releases, not from readest.com.

Each release publishes a signed updater manifest — `latest.json` for the replacing Android family and the desktop builds, `latest-coexist.json` for the coexisting Android family — together with the `.sig` files the Tauri updater verifies against a public key compiled into the app. The Windows portable zip is the exception described above and does not update itself. The private signing key is held only in this repository's secrets and never ships in a build. Keep that private key and its password: because the matching public key is compiled into the app, losing them means no future release can be signed and already-installed apps will stop accepting updates.

## Verification

Three independent layers, none of them a stronger claim than what it actually checks:

1. **Source assertions.** `tools/verify.mjs` runs after the patch and before the expensive native build, so a broken patch fails in seconds rather than after a long build.
2. **The built artifact.** `tools/check-bundle.mjs` runs after the frontend build and asserts the `__READEST_UNLOCKED__` build marker against the JavaScript the app actually ships. This is the difference between "we edited the right file" and "the shipped bundle is unlocked".
3. **CI failure.** If either assertion fails, the job fails and produces no artifacts, so a partially patched release is never published.

The patched module also sets `globalThis.__READEST_UNLOCKED__ = true` at runtime, which is what makes layer 2 possible and what an installed build can be checked against.

## Installing

The artifacts are not signed by a code-signing certificate.

- **Windows**: SmartScreen warns on first run. The installer updates itself; the portable zip does not.
- **macOS**: Gatekeeper blocks the first launch. Run `xattr -cr /Applications/Readest.app`, then open the app again.
- **Android**: see [the two families](#the-two-android-families) above before choosing an APK.

## License and compliance

Readest is licensed under **AGPL-3.0**, and so are this repository's scripts and the binaries published here. The full license text is in [LICENSE](LICENSE).

The AGPL asks anyone distributing a modified version to provide the Corresponding Source and to carry prominent notices that files were changed. This repository is that source: it holds the complete set of patch scripts and the exact build recipe, and every file the patches touch is marked in place with a `[readest-unlocked]` comment naming the change.

The published binaries keep upstream's copyright notices, license text and project identity. Nothing here removes or replaces them.

This project is not affiliated with, endorsed by or supported by Readest or Bilingify LLC. "Readest" and its logo belong to their owners and are used here only to describe what this build is derived from. Support for this build comes from this repository, not from upstream.

These builds are provided as-is, with no warranty, for personal use. You are responsible for complying with the licenses and terms of any third-party service the app talks to.

## Repository layout

```
.github/workflows/build-unlocked.yml   the pipeline
helpers/android-keystore.sh            writes the Android signing config after each `tauri android init`
tools/unlock.mjs                       the patcher
tools/coexist.mjs                      switches a checkout to the coexisting Android identity
tools/coexist-android.mjs              re-points the committed src-tauri/gen/android project at that identity
tools/verify.mjs                       source assertions
tools/check-bundle.mjs                 built-bundle assertion
tools/make-manifest.mjs                assembles the signed updater manifests
tools/resolve-upstream.mjs             upstream version resolution
README.md                              this file (English)
README.zh-CN.md                        Chinese translation
LICENSE                                AGPL-3.0
```
