import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      'resources/**',
      'api/**',
      'arch/**',
      'docs/**',
      // Agent tooling vendored into the repo by `orvix init`, not our source.
      '.claude/hooks/**',
      '**/*.test.mjs'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Renderer (React, browser environment)
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: {
      // Proven, high-value hook rules. The v7 "recommended" set adds many
      // opinionated React-Compiler-era rules that flood a legacy codebase.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  // Main / preload / scripts (Node environment)
  {
    files: ['electron/**/*.{ts,mts,mjs}', 'scripts/**/*.{js,mjs,cjs}', 'tools/**/*.{ts,mjs}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  // CommonJS files (Node, require/module)
  {
    files: ['scripts/**/*.{js,cjs}', 'tailwind.config.js', 'postcss.config.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  // Project-wide rule tuning
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      // require() is used intentionally in Electron main and Node build scripts
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // Stripping ANSI escape codes requires control chars in regex
      'no-control-regex': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  }
)
