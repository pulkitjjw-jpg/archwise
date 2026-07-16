# Multi-stage build for the Next.js frontend, using output: "standalone" (see next.config.ts) so
# the final image ships only the files actually needed at runtime, not a full node_modules tree.
# Not wired into docker-compose.yml's default `up` -- the established local workflow is
# `npm run dev` on the host (see backend's own Dockerfile comment about why backend/postgres/
# redis are containerized but the frontend historically wasn't). This image is for production-
# like deployment/testing; run it explicitly via `docker compose up frontend` or `docker build`.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time, not read at container
# runtime -- a plain `environment:` entry in docker-compose.yml (which only affects the running
# container) has no effect on this. Must be passed as a build arg instead.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
# Same build-time-inlining constraint as the Clerk key above -- see next.config.ts/
# src/instrumentation-client.ts. Empty by default (no real Sentry account exists for this app
# yet), which keeps next.config.ts's withSentryConfig wrapper skipped and Sentry.init() never
# called anywhere in the resulting build, same as a bare-metal `npm run build` with no DSN set.
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
# Only consulted by next.config.ts's withSentryConfig for source map upload, and only when
# NEXT_PUBLIC_SENTRY_DSN above is actually set -- harmless to leave unset otherwise.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}
ENV SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Non-root user/group, following Next.js's own documented convention for `output: standalone`
# images (nextjs:nodejs, both fixed system IDs) -- runs the server process with no more
# privilege than it needs.
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# No public/ directory exists in this project (confirmed -- nothing to copy); standalone output
# already includes everything else `next build` decided the server actually needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# src/proxy.ts (this project's Next.js 16 middleware, via clerkMiddleware) redirects an
# AUTHENTICATED "/" request to /dashboard, but always lets an unauthenticated one through as a
# plain 200 -- and a cookie-less container healthcheck request is never authenticated, so this is
# a reliable, unfaked-session way to prove the Next.js server is actually up and serving. (The
# real backend health check already lives on the FastAPI container -- see backend/Dockerfile --
# this just confirms the gateway itself is alive.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null --spider http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
