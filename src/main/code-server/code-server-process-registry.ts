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

let codeServerPid: number | null = null

export function setCodeServerPid(pid: number | null): void {
  codeServerPid = typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : null
}

export function getCodeServerPid(): number | null {
  return codeServerPid
}
