import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-process-exit': 'error',
    },
  },
  {
    // P6: this config file lints itself. It is not part of the type-checked project
    // (`tsconfig.json` includes only `src/`, `__tests__/` and the two vitest configs), so the
    // type-checked rule set is switched off for it and only the untyped `js.configs.recommended`
    // rules above apply.
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Build output and installed packages, plus the WireMock fixture generator, a one-off `node`
    // script whose JSON product is committed. The generator is not part of the type-checked
    // project, so the typed rules cannot be applied to it at all.
    ignores: ['dist/**', 'node_modules/**', 'test/wiremock/generate-mappings.mjs'],
  },
);
