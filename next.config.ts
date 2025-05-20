import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ignore build errors during CI
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
