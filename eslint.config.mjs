import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/cdk.out/**',
      '**/dist/**',
      '.local/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        __dirname: 'readonly',
        crypto: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript already resolves identifiers, including type-only ones like
      // `NodeJS.ProcessEnv` and DOM lib types. `no-undef` cannot see them and
      // produces only false positives on typed source.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Guard rail: secrets must never be read from a committed literal.
          selector:
            "Literal[value=/^(EAA[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})$/]",
          message: 'Possible hardcoded access token. Store secrets in Secrets Manager.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'services/handlers/src/admin/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Tests need token-shaped fixtures to prove redaction and error mapping
    // actually work. The guard stays on for everything that ships.
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
