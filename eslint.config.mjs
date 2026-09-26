import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

// `next lint` is deprecated and removed in Next.js 16, so this project uses
// the ESLint CLI directly (see the "lint" script in package.json).
// eslint-config-next is still distributed as eslintrc-style config, hence
// FlatCompat.
const config = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "next-env.d.ts",
      // Vendored minified engines — not project code, and linting a multi-MB
      // minified wasm shim only produces noise errors (require(), this-alias).
      "public/stockfish/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
