/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-hosted builds (Dockerfile, docs/HOSTING-MIGRATION-PLAN.md) set
  // BUILD_STANDALONE=1 to get .next/standalone: a self-contained `node
  // server.js` with only the node_modules it actually traces. Left unset on
  // Vercel, which packages the app its own way, so that build is unchanged.
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,
};

module.exports = nextConfig;
