/// <reference types="vitest/jsdom" />

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Node 26 exposes its own storage global. Tests use the browser storage for the JSDOM origin.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: jsdom.window.localStorage,
})

afterEach(() => {
  cleanup()
})
