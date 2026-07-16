import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Vitest over Jest: this app is Turbopack/ESM throughout (Next.js 16, React 19), and Vitest's
// Vite-based config needs none of the extra moving parts (ts-jest/babel-jest transform config,
// moduleNameMapper for CSS/asset imports, manual ESM interop) that Jest's Next.js integration
// requires for marginal benefit here. tsconfigPaths() resolves the "@/*" alias from tsconfig.json
// the same way Next.js does, so imports don't need per-test relative-path rewriting.
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    css: false,
    // Playwright specs live under e2e/ and run through the separate `playwright test` runner
    // (see playwright.config.ts) -- excluded here so `vitest run` never tries to execute them.
    exclude: ["node_modules/**", "e2e/**", ".next/**"],
  },
});
