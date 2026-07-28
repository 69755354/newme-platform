# Keep this tag aligned with infra/staging/uat-runner/package-lock.json.
# The staging builder copies only this Dockerfile, runner manifests, run.sh, and
# verify-staging-sam26-roles.mjs into a temporary Docker build context.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /runner

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && mkdir -p /runner/home \
  && chown -R pwuser:pwuser /runner

COPY verify-staging-sam26-roles.mjs /runner/verify-staging-sam26-roles.mjs
COPY run.sh /runner/run.sh
RUN chmod 0555 /runner/run.sh \
  && chown pwuser:pwuser /runner/verify-staging-sam26-roles.mjs /runner/run.sh

ENV HOME=/runner/home \
    NODE_ENV=production

USER pwuser
ENTRYPOINT ["/runner/run.sh"]
