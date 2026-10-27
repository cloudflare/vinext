# syntax=docker/dockerfile:1

# Build environment for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as the build context. Network access is only
# available during this build, so everything the tests need offline must be installed here.
FROM node:24-bookworm

# CI=true matches GitHub Actions and keeps vitest out of watch mode.
ENV CI=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Install the pnpm version pinned by `packageManager` in package.json.
RUN npm install -g "$(node -p 'require("./package.json").packageManager')"

# The root postinstall builds workers-response-store, @vinext/cloudflare, vinext and
# create-vinext-app, then generates workspace types, so dist/ is ready after this step.
RUN pnpm install --frozen-lockfile

# `vp` (Vite+) comes from the root vite-plus devDependency.
ENV PATH=/src/node_modules/.bin:$PATH

# Chromium for the Playwright e2e suites (playwright.config.ts).
RUN pnpm exec playwright install --with-deps chromium

# Smoke test: cheap security-focused unit tests. A failure is logged, not fatal.
RUN vp test run --project unit tests/action-runtime-security.test.ts tests/api-handler-trust-proxy.test.ts \
    || echo "WARNING: smoke tests reported failures"
