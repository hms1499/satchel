// Bundles the seller kit into one ESM file (dependencies stay external), then emits the type declarations.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  external: ["@bitauth/libauth", "@electrum-cash/network"],
  logLevel: "info",
});

// Declarations for src/index.ts and the modules it imports (test files are not reachable from it).
execFileSync(
  "npx",
  [
    "tsc", "src/index.ts",
    "--declaration", "--emitDeclarationOnly", "--outDir", "dist", "--rootDir", "src",
    "--target", "ES2022", "--lib", "ES2022,DOM", "--module", "ESNext", "--moduleResolution", "bundler",
    "--strict", "--skipLibCheck", "--isolatedModules", "--types", "node",
  ],
  { stdio: "inherit" },
);
