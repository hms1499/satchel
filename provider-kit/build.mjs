// Bundles the seller kit into one ESM file (dependencies stay external), then emits the type declarations.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// Sources use extensionless relative imports (bundlers such as Turbopack do not map "./x.js" to x.ts), but node16 and
// nodenext consumers need "./x.js" in the declarations to resolve them.
for (const file of readdirSync("dist").filter((f) => f.endsWith(".d.ts"))) {
  const path = `dist/${file}`;
  const src = readFileSync(path, "utf8");
  const out = src.replace(/((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+?)(?<!\.js)\2/g, "$1$2$3.js$2");
  if (out !== src) writeFileSync(path, out);
}
