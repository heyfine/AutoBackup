import { defineConfig } from 'eslint/config'
import typescriptEslint from 'typescript-eslint'

export default defineConfig(
  typescriptEslint.config({
    files: ['src/**/*.ts'],
    extends: [...typescriptEslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  }),
  {
    ignores: ['node_modules/', 'dist/', 'web/'],
  },
)
