/**
 * Tracks the PID of the single shared code-server process so the memory
 * collector can attribute the embedded editor's whole process subtree: the
 * server plus its extension host, language servers, and ripgrep, to Orca's
 * footprint. code-server is one shared, reference-counted process app-wide, so
 * a single pid slot suffices. Local only: the embedded editor never runs over
 * SSH, so its tree is always visible to the local `ps` sweep.
 *
 * Kept separate from code-server-manager.ts so the collector can read the pid
 * without importing the manager (and its Electron/spawn dependencies).
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { getCodeServerPidFilePath } from './code-server-paths'

let codeServerPid: number | null = null

export function setCodeServerPid(pid: number | null): void {
  codeServerPid = typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : null
}

export function getCodeServerPid(): number | null {
  return codeServerPid
}

export function reapOrphanCodeServerProcess(): void {
  const pidFile = getCodeServerPidFilePath()
  if (!existsSync(pidFile)) {
    return
  }
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGTERM')
    }
  } catch {
    // process already gone or not ours; ignore
  } finally {
    try {
      rmSync(pidFile, { force: true })
    } catch {
      // best effort
    }
  }
}
