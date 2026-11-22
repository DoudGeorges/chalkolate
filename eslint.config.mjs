import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['**/.next/**', '**/out/**', '**/dist/**', '**/build/**', '**/next-env.d.ts', '**/.venv/**']),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // The monitor/speech hooks intentionally mirror latest props into refs during render and
      // sync state from effects; keep the classic
      // rules-of-hooks / exhaustive-deps checks while skipping React Compiler-era strictness.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // Uploaded media previews are local blob/object URLs, which next/image cannot optimize.
      '@next/next/no-img-element': 'off',
    },
  },
])
