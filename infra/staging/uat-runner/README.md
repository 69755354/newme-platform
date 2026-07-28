# Staging UAT runner

This directory builds the browser runtime for `scripts/verify-staging-sam26-roles.mjs` without adding Playwright or Chromium to the Next.js standalone release.

The staging-only build service must create a fresh temporary Docker build context containing exactly these five files from the exact checked-out SHA:

- `infra/staging/uat-runner/Dockerfile`
- `infra/staging/uat-runner/package.json`
- `infra/staging/uat-runner/package-lock.json`
- `infra/staging/uat-runner/run.sh`
- `scripts/verify-staging-sam26-roles.mjs`

It then builds:

```bash
docker build --tag "newme-staging-uat:${SHA}" -f Dockerfile <temporary-context>
```

The restricted `newme-staging-control uat <SHA>` action must run that exact image with only the staging environment file, inject `SAM26_EXPECTED_RELEASE_SHA=<SHA>`, and never mount production paths, production environment files, source worktrees, or the Docker socket into the container.

Use `--rm --init --ipc=host --read-only` plus writable tmpfs mounts for `/tmp` and `/runner/home`. The runner image is disposable: a failed build or failed UAT must not replace the live staging release.

The image tag, `package.json`, and lockfile deliberately pin Playwright `1.60.0` together.
