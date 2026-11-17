// Bundles the MCP server (and the shared Satchel modules it imports from ../src/lib) into one ESM file.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  loader: { ".json": "json" },
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "cashscript", "@bitauth/libauth", "zod"],
  logLevel: "info",
});
