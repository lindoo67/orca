import { get } from 'node:http'

const READY_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 10_000
const READY_POLL_MS = 200

export async function waitForHealthz(port: number, isChildAlive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() <= deadline) {
    if (!isChildAlive()) {
      return false
    }
    const ok = await probeHealthz(port)
    if (ok) {
      return true
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS))
  }
  return false
}

export function probeHealthz(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(`http://127.0.0.1:${port}/healthz`, (response) => {
      response.on('data', () => {})
      response.on('end', () => resolve(response.statusCode === 200))
    })
    request.on('error', () => resolve(false))
    request.end()
  })
}
