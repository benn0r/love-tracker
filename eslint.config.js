import eslint from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "data/**",
      "node_modules/**",
      "playwright-report/**",
      "public/vendor/**",
      "test-results/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: [
      "server.js",
      "playwright.config.js",
      "scripts/**/*.js",
      "test/**/*.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["public/app.js", "public/i18n.js", "public/respond.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, L: "readonly" },
    },
  },
  {
    files: ["public/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: globals.serviceworker,
    },
  },
];
