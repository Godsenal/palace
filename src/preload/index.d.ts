import type { PalaceAPI } from '../shared/types'

declare global {
  interface Window {
    palace: PalaceAPI
  }
}

export {}
