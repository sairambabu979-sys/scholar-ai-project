import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const webOnly = (configs) =>
  configs.map((c) => ({ ...c, files: c.files ?? ["apps/web/**/*.{ts,tsx,js,jsx,mjs}"] }));

const config = [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/coverage/**",
      "packages/db/src/generated/**",
      "playwright-report/**",
      "test-results/**",
      "apps/web/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    settings: { next: { rootDir: "apps/web" } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='eval']",
          message: "eval is forbidden: provider and model text is untrusted content.",
        },
      ],
    },
  },
  ...webOnly(nextVitals),
  ...webOnly(nextTs),
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    settings: { next: { rootDir: "apps/web" } },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@scholar/testing",
              message: "Fixtures and mock adapters belong to the worker/tests, never the web app.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
