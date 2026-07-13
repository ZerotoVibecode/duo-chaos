import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

export async function launchIsolatedElectron(): Promise<{
  electronApp: ElectronApplication
  close: () => Promise<void>
}> {
  const userData = await mkdtemp(join(tmpdir(), 'duo-chaos-e2e-'))
  let electronApp: ElectronApplication | undefined

  try {
    electronApp = await electron.launch({
      args: [join(process.cwd(), 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        DUO_CHAOS_E2E: '1',
        DUO_CHAOS_E2E_USER_DATA: userData,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    })
  } catch (error) {
    await rm(userData, { recursive: true, force: true })
    throw error
  }

  return {
    electronApp,
    close: async () => {
      await electronApp.close()
      await rm(userData, { recursive: true, force: true })
    }
  }
}
