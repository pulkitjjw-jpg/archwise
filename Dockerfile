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
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# No public/ directory exists in this project (confirmed -- nothing to copy); standalone output
# already includes everything else `next build` decided the server actually needs.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
