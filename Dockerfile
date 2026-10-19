# syntax=docker/dockerfile:1.7
#
# HIOC web app as a single self-contained Node server, for the self-hosted
# setup in docs/HOSTING-MIGRATION-PLAN.md. Vercel ignores this file.
#
# Build (GitHub Actions does this in .github/workflows/deploy-server.yml):
#   docker build --secret id=public_env,src=.env.production -t hioc-web .
#
# NEXT_PUBLIC_* values are inlined into the JS at BUILD time, not read at
# runtime, so they must be present here. They arrive as a BuildKit secret
# mounted at /app/.env.production for the one `next build` step: next reads
# that file itself, and no `ARG` per flag has to be kept in sync with
# lib/flags.ts. Server-only secrets (service-role key, Razorpay, WhatsApp, …)
# are NOT needed to build and never enter the image — they come from the
# server's /opt/hioc/.env at runtime.

# Node 24 matches the Vercel project's runtime (Project Settings → Node.js).
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Next 14 in standalone mode needs sharp for next/image; without it the
# optimiser falls back to a slow WASM path. Installed here rather than in
# package.json so the Vercel build (which has its own optimiser) is untouched.
RUN npm install --no-save --no-audit --no-fund sharp@0.33.5

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 BUILD_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=secret,id=public_env,target=/app/.env.production \
    npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
# UTC on purpose: Vercel functions run in UTC and the app's IST handling
# (cash days, attendance, reports) was written and tested against that.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 TZ=UTC
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# The build-time env file is not runtime config; drop the copy standalone
# output makes of it so only /opt/hioc/.env ever configures the server.
RUN rm -f .env.production
USER node
EXPOSE 3000
# /privacy is a static page: it proves the server answers without making the
# container's health depend on Supabase being reachable.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/privacy').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
