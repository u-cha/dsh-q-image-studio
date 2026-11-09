# Publishing Q Image Studio

Package: [`@u-cha/dsh-q-image-studio`](https://www.npmjs.com/package/@u-cha/dsh-q-image-studio).

Releases are built on GitHub and published by npm Trusted Publishing (OIDC). There is no `NPM_TOKEN` in this repository and none should be added.

## Requirements

- Node.js **≥ 22.14.0** (the workflow uses Node 24)
- npm CLI **≥ 11.5.1** — required for OIDC and installed by the workflow
- A GitHub-hosted runner. Self-hosted runners cannot obtain the OIDC token.

## First publish (one time, manual)

Trusted Publishing can only be configured after the package exists on npm.

```bash
# run from the package root
npm login                 # account u-cha
npm whoami                # must print u-cha
npm test                  # all tests must pass
npm pack --dry-run        # inspect the package contents
npm publish --access public
```

If npm fails with `EPERM` while writing its cache because the files are owned by root:

```bash
sudo chown -R 501:20 ~/.npm
```

## Configure Trusted Publishing (one time)

1. Open the package settings on npmjs.com: **Packages → @u-cha/dsh-q-image-studio → Settings**.
2. Under **Trusted Publisher**, choose **GitHub Actions**.
3. Fill in:
   - Organization or user: `u-cha`
   - Repository: `dsh-q-image-studio`
   - Workflow filename: `publish.yml`
   - Environment: leave empty
4. Save and allow `npm publish` for this publisher.
5. If an `NPM_TOKEN` secret exists in the GitHub repository, delete it. It is no longer used and should be revoked on npm as well.

The public repository must match those values. The workflow file lives at `.github/workflows/publish.yml` in this package.

## Release a new version

1. Update `version` in `package.json` (semver).
2. Add the matching entry to `CHANGELOG.md` and update the README if behavior changed.
3. Commit, then create and push a tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. The **Publish to npm** workflow runs on the tag and:
   - installs dependencies and runs `npm test`;
   - checks that `v<package.json version>` equals the pushed tag;
   - checks that the version is not already on npm;
   - upgrades npm to ≥ 11.5.1 and publishes with `npm publish --access public`.

If the tag and version differ, or the version already exists, the workflow fails before publishing.

## Install the published package

```bash
dsh plugin add @u-cha/dsh-q-image-studio
```

Or in DSH: **Plugins → Install**, then paste the package name. Restart DSH when prompted, add a provider profile, and paste your own DashScope key into the plugin settings — keys are stored only in the DSH vault.

## Maintenance notes

- Do not commit `node_modules/`, npm logs, or `.DS_Store`.
- The published tarball excludes tests, internal `NOTES*.md`, the publishing guide, and GitHub workflow files.
- `docs/screenshot.png` is included because the README references it.
- Keep the GitHub repository public: the README links and npm metadata point to `https://github.com/u-cha/dsh-q-image-studio`.
