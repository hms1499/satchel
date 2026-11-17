import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // examples/* have their own install and test run.
  test: { exclude: [...configDefaults.exclude, "examples/**", "**/node_modules/**", "**/dist/**"] },
});
