import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Owner's code style: any function with more than 2 parameters must take a
  // single object argument instead.
  {
    rules: {
      "max-params": ["error", { max: 2 }],
    },
  },
  // Spike code is throwaway and exempt from the max-params style rule.
  {
    files: ["src/app/spike/**"],
    rules: {
      "max-params": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    /*
      Every Next build output, not just `.next`. The e2e run writes to
      `.next-e2e/`, which no default ignore covered: locally that dir exists and
      buried the real findings under ~31.5k problems, while CI checks out clean
      and never sees it. The lint result has to mean the same thing in both
      places, so match the whole family rather than naming one more directory.
    */
    ".next-*/**",
  ]),
]);

export default eslintConfig;
