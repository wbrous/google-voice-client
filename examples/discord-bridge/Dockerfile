# Builds the `google-voice-client` library from source and installs the
# Discord bridge example against it — no npm publish required. Both the
# `bridge` and `refresh-tokens` compose services share this image; only
# their `command` differs (see docker-compose.yml).
#
# Build context MUST be the repository root:
#   docker compose -f examples/discord-bridge/docker-compose.yml build
# (docker-compose.yml sets `build.context: ..` so this Dockerfile can COPY
# both the library and the example.)
FROM oven/bun:1 AS base
WORKDIR /repo

# Native addons (e.g. better-sqlite3 via discord.js) need a C++ toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# --- Build the library ---------------------------------------------------
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun run build
# Registers this checkout as the `google-voice-client` package, exactly
# like the local dev workflow's `cd .. && bun link` — done here inside the
# image so it doesn't depend on any host-level global link state.
RUN bun link

# --- Install the bridge ---------------------------------------------------
WORKDIR /repo/examples/discord-bridge
COPY examples/discord-bridge/package.json ./
# Resolves the bridge's "google-voice-client": "link:google-voice-client"
# dependency against the link registered above.
RUN bun install

# Chromium + its OS-level shared libs. Only bin/refresh-tokens.ts (the
# `refresh-tokens` service) launches a browser — the `bridge` service never
# touches Playwright — but both run from this one image, so install it
# here. Placed right after `bun install` (before the source COPYs below) so
# editing index.ts/bin doesn't bust this ~4-minute layer's cache.
RUN bunx playwright install --with-deps chromium

COPY examples/discord-bridge/tsconfig.json ./
COPY examples/discord-bridge/index.ts ./
COPY examples/discord-bridge/bin ./bin

CMD ["bun", "run", "start"]
