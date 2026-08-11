# Releasing

Publishing is done by GitHub Actions, not by hand. Cutting a GitHub Release
triggers [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which
re-runs the full test suite on both SQLite and Postgres, checks the tag against
`package.json`, and publishes with signed provenance.

Nobody publishes from a laptop. That is deliberate: a manual `npm publish` can
ship uncommitted changes, skip the tests, or upload from a machine no one can
audit. The workflow can do none of those.

## One-time setup

Two things have to exist before the first release, and neither can be done from
this repository — they are on npm and GitHub.

### 1. An npm automation token

Create a **granular access token** on npm (Account → Access Tokens → Generate →
Granular) with **write** access to the `angusjs` package. A granular token
scoped to one package is far less dangerous than a classic automation token,
which can publish anything you own.

Add it to the repository as a secret named `NPM_TOKEN`:

> GitHub repo → Settings → Secrets and variables → Actions → New repository secret

### 2. First publish claims the name

`angusjs` is currently unregistered. The first successful run of this workflow
registers it. After that, only this workflow can publish new versions using the
token.

### Upgrade path: trusted publishing (no token)

npm supports OIDC **trusted publishing**, which removes the token entirely: you
register this repository and workflow as a trusted publisher on npm, and the
`id-token: write` permission the workflow already has authenticates the publish.
A token that does not exist cannot leak. Once the package is published once, set
this up in the package settings on npm and delete the `NPM_TOKEN` secret; the
workflow needs no change.

## Cutting a release

1. **Bump the version.** Edit `package.json`, following semver — `0.x` means the
   API can still break between minor versions.

   ```bash
   # edit "version" in package.json, then:
   git commit -am "Release 0.2.0"
   git push
   ```

2. **Rehearse it (optional).** Run the workflow manually with *Dry run* left on:

   > Actions → Publish → Run workflow

   This packs the tarball and prints its contents without claiming the version.

3. **Tag and release.** The tag must match the version, with a `v` prefix — the
   workflow refuses a mismatch rather than publishing a version that lies about
   itself.

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

   Then create the release on GitHub from that tag, with notes drawn from
   [CHANGELOG.md](CHANGELOG.md). Publishing the release starts the workflow.

4. **Watch it.** The Actions tab shows the run: verify, then publish. If verify
   fails, nothing is published.

## After publishing

Confirm what actually shipped:

```bash
npm view angusjs version
npm view angusjs dist-tags
```

A published version cannot be replaced — npm allows unpublishing only within 72
hours, and never allows republishing the same number. If something is wrong,
the fix is a new version, not an edit to the old one.
