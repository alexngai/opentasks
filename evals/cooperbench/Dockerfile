# OpenTasks daemon image for the CooperBench sidecar topology.
# Built from local source so it carries the attempt/verify feature
# (feat/attempt-verify-schema), not the published package.
#
# Single stage (size doesn't matter for a sidecar): npm ci builds better-sqlite3
# natively for linux, then tsc emits dist/. The CLI is invoked as
# `node dist/cli.js`.
FROM node:20-slim
WORKDIR /app

# Build toolchain for better-sqlite3's native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps (native modules compiled for linux inside the image).
COPY package.json package-lock.json ./
RUN npm ci

# Build the CLI + library.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Smoke scripts (thin clients over the shared daemon socket).
COPY evals/cooperbench/smoke ./evals/cooperbench/smoke

# Runs as root: every container in the smoke shares root, so the daemon-created
# socket on the shared volume is rw for the agents. A real deployment would
# align a non-root uid across containers instead.
