# Keep this tag aligned with infra/staging/uat-runner/package-lock.json.
# The staging builder copies only this Dockerfile, runner manifests, run.sh, and
# the versioned staging UAT scripts into a temporary Docker build context.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /runner

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && mkdir -p /runner/home \
  && chown -R pwuser:pwuser /runner

COPY verify-staging-sam26-roles.mjs /runner/verify-staging-sam26-roles.mjs
COPY verify-staging-sam70-xlsx.mjs /runner/verify-staging-sam70-xlsx.mjs
COPY sam23-organization-commercial-core.mjs /runner/sam23-organization-commercial-core.mjs
COPY product-saas-final.mjs /runner/product-saas-final.mjs
COPY sam78-staging-tenant-closure.mjs /runner/sam78-staging-tenant-closure.mjs
COPY v4-staging-acceptance.mjs /runner/v4-staging-acceptance.mjs
COPY run.sh /runner/run.sh
RUN chmod 0555 /runner/run.sh \
  && chown pwuser:pwuser \
    /runner/verify-staging-sam26-roles.mjs \
    /runner/verify-staging-sam70-xlsx.mjs \
    /runner/sam23-organization-commercial-core.mjs \
    /runner/product-saas-final.mjs \
    /runner/sam78-staging-tenant-closure.mjs \
    /runner/v4-staging-acceptance.mjs \
    /runner/run.sh

ENV HOME=/runner/home \
    NODE_ENV=production

USER pwuser
ENTRYPOINT ["/runner/run.sh"]
