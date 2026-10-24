import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "pg", "eve"],
  typescript: { ignoreBuildErrors: true },
  experimental: { turbopackFileSystemCacheForDev: false },
};

export default withEve(nextConfig);
