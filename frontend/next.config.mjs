import { fileURLToPath } from "node:url";
import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  async rewrites() {
    const origin = process.env.BACKEND_ORIGIN || "http://localhost:8000";
    return [
      { source: "/api/v1/:path*", destination: `${origin}/api/v1/:path*` },
    ];
  },
};

export default nextConfig;
