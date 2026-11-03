# Linux test-feedback image for the Ky fixture. Dependencies come only from the
# frozen package-lock.json; install scripts are skipped and no browser is downloaded.
# The trial workspace is never baked in: each run copies a read-only snapshot.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NO_COLOR=1 CI=1 NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && rm package.json package-lock.json && chown -R node:node /work
USER node
