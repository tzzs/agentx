import tseslint from "typescript-eslint";

/**
 * The type checker carries most of the safety here (strict mode plus
 * noUncheckedIndexedAccess), so ESLint keeps only what tsc can't see: an
 * accidental `any` reintroduced at a wire boundary, and dead code.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { args: "all", argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    // Tests stub providers with loosely-shaped JSON, and an assertion's shape
    // is exactly what a test is allowed to leave imprecise.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
