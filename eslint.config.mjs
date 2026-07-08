import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    rules: {
      // This app fetches data in effects (no Suspense/data-fetching library in use), which is a
      // legitimate, documented React pattern that this React Compiler-oriented rule flags anyway.
      // Downgraded to a warning rather than rewriting the data-loading architecture.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);
