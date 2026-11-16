import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Electrum (ws) client must stay a server-side external in route handlers.
  serverExternalPackages: ["@electrum-cash/network", "ws"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
