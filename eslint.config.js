import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      eqeqeq: "error",
      "no-console": "error",
      "no-param-reassign": "error",
      "prefer-const": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/require-array-sort-compare": "error",
      "@typescript-eslint/promise-function-async": "error",
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
