import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', 'runs/**', 'output/**', 'tmp/**', 'dashboard/config/lp-portfolio-ledger.json'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['dashboard/public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
]
