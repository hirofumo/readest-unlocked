# battery (vendored)

This is the published `battery` crate, version 0.7.8, with three small changes on
top. It exists so the 32-bit Windows build can compile at all. `README.md`
beside this file is the crate's own.

## Why

`battery` 0.7.8 is the newest release of the crate — published in November 2020
and unmaintained since. In its Windows FFI it takes a reference to a field of a
`#[repr(packed)]` struct:

```rust
let device_path = unsafe { (***pdidd).DevicePath.as_ptr() };
```

Modern rustc rejects that with `error[E0793]: reference to field of packed struct
is unaligned`. That check is a hard error, so neither `#[allow]` nor
`--cap-lints` can get past it. readest depends on the crate transitively, and
because no fixed release exists, the fix has to live next to the build.

The same problem appears twice, both in `src/platform/windows/ffi/mod.rs`, at
lines 113 and 143 of the published file.

## What changed

Two expressions, and one attribute.

The pointers:

```rust
// was: (***pdidd).DevicePath.as_ptr()
core::ptr::addr_of!((***pdidd).DevicePath).cast::<u16>()

// was: &mut query.BatteryTag as *mut _ as minwindef::LPVOID
core::ptr::addr_of_mut!(query.BatteryTag) as minwindef::LPVOID
```

Both produce the same address; they simply avoid materialising a reference to an
unaligned field, which is the undefined behaviour the compiler objects to. The
access itself is unchanged, and x86 tolerates unaligned loads and stores.

With those fixed, i686 progress stops on a second problem in the same file:
`pdidd` is a raw pointer, so writing through it never requires the binding to be
mutable, and rustc reports `unused_mut` — which `#![deny(unused)]` in `lib.rs`
promotes to an error. The binding keeps its `mut`, because the targets that do
need it must keep compiling, and gains a statement-level `#[allow(unused_mut)]`.

## How it is wired up

`helpers/patch-battery-crate.mjs` appends a `[patch.crates-io]` entry to the
workspace root `Cargo.toml` pointing at this directory. Cargo only honours
`[patch]` in a workspace root manifest, which is why it is not added to the app
manifest instead. That step runs on the 32-bit Windows leg alone, so every other
platform keeps resolving the crate from crates.io.

Licence: MIT OR Apache-2.0, as published. Both licence files are kept here.
