/// <reference types="vite/client" />

import type { DuoElectronApi } from '@shared/electron-api'

declare global {
  interface Window {
    duo: DuoElectronApi
  }
}

export {}
