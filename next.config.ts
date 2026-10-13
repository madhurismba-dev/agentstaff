import type { NextConfig } from "next";

// Static export: ChiefOS has no server. It runs entirely in the browser and can be hosted anywhere for free.
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
