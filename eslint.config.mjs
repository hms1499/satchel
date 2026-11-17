import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // satchel-pay-mcp has its own package and typecheck; its bundle is generated.
    "mcp/dist/**",
    "mcp/node_modules/**",
    // satchel-pay-server: same, plus the example sellers' own installs.
    "provider-kit/dist/**",
    "examples/**/node_modules/**",
  ]),
]);

export default eslintConfig;
