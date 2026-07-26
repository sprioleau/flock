import tseslint from "typescript-eslint";

/**
 * Minimal config — typecheck covers correctness; this enforces ONLY the
 * owner's code style: any function with more than 2 parameters must take a
 * single object argument instead.
 */
export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
    },
    // Registered (with no rules enabled) so existing inline
    // `eslint-disable @typescript-eslint/...` comments still resolve.
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    // Those directives are "unused" here by design: this config enforces only
    // max-params, so don't warn about disables for rules it doesn't enable.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "max-params": ["error", { max: 2 }],
    },
  },
];
