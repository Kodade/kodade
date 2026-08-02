# Dependency license bundle

The generated files in `generated/` are the complete third-party dependency
license and attribution bundle for Ködade's macOS Apple Silicon public build.
They cover the production JavaScript tree from `pnpm-lock.yaml` and the Rust
tree selected by Cargo for `aarch64-apple-darwin` with the public app's default
features.

Regenerate after any dependency, version, generator, or override change:

```bash
cargo install cargo-about --version 0.9.1 --locked --features cli
pnpm licenses:generate
pnpm licenses:verify
```

`licenses:verify` is part of the public build gate. It compares the recorded
input and output hashes and fails closed when the checked-in bundle is stale.
The release staging script copies only `generated/` into the app bundle.

`javascript-overrides/` contains version-pinned upstream license texts for npm
packages whose published tarballs omit them. Updating either package version
requires an explicit override review.
