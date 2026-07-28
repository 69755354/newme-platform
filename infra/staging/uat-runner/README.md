# Staging UAT runner

This directory builds the browser runtime for `scripts/verify-staging-sam26-roles.mjs` without adding Playwright or Chromium to the Next.js standalone release.

The staging-only build service must build the image from the exact checked-out SHA:

```bash
docker build --pull --tag "newme-staging-uat:${SHA}" -f infra/staging/uat-runner/Dockerfile .
```

The restricted `newme-staging-control uat <SHA>` action must run that exact image with only the staging environment file, inject `SAM26_EXPECTED_RELEASE_SHA=<SHA>`, and never mount production paths, production environment files, Docker source worktrees, or the Docker socket into the container.

The image tag, `package.json`, and lockfile deliberately pin Playwright `1.60.0` together. A runner image is disposable: a failed build or failed UAT must not replace the live staging release.
