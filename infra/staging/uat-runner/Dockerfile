# Keep this tag aligned with infra/staging/uat-runner/package-lock.json.
# The official Playwright image supplies the matching headless Chromium and OS libraries.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /runner

COPY infra/staging/uat-runner/package.json infra/staging/uat-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && mkdir -p /runner/home \
  && chown -R pwuser:pwuser /runner

COPY scripts/verify-staging-sam26-roles.mjs /runner/verify-staging-sam26-roles.mjs
RUN chown pwuser:pwuser /runner/verify-staging-sam26-roles.mjs

ENV HOME=/runner/home \
    NODE_ENV=production

USER pwuser
ENTRYPOINT ["node", "/runner/verify-staging-sam26-roles.mjs"]
