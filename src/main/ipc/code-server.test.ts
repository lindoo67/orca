import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, serviceMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  serviceMock: {
    acquire: vi.fn(),
    retry: vi.fn(),
    release: vi.fn(),
    getStatus: vi.fn(() => ({ status: 'stopped', port: null })),
    onStatusChanged: vi.fn(() => () => {})
  }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../code-server/code-server-service', () => ({ getCodeServerService: () => serviceMock }))

import { registerCodeServerHandlers } from './code-server'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find(
    (entry): entry is [string, (...args: unknown[]) => unknown] =>
      entry[0] === channel && typeof entry[1] === 'function'
  )
  if (!call) {
    throw new Error(`${channel} not registered`)
  }
  return call[1]
}

describe('registerCodeServerHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    serviceMock.acquire.mockReset()
    serviceMock.retry.mockReset()
    registerCodeServerHandlers()
  })

  it('returns the port on ensureRunning', async () => {
    serviceMock.acquire.mockResolvedValue({ port: 5555 })
    const result = await getHandler('codeServer:ensureRunning')({})
    expect(result).toEqual({ port: 5555 })
  })

  it('returns a structured error when acquire throws', async () => {
    serviceMock.acquire.mockRejectedValue(new Error('offline'))
    const result = await getHandler('codeServer:ensureRunning')({})
    expect(result).toEqual({ error: 'offline' })
  })

  it('re-drives the start on retry without acquiring a ref', async () => {
    serviceMock.retry.mockResolvedValue({ port: 6666 })
    const result = await getHandler('codeServer:retry')({})
    expect(result).toEqual({ port: 6666 })
    expect(serviceMock.acquire).not.toHaveBeenCalled()
  })

  it('returns a structured error when retry throws', async () => {
    serviceMock.retry.mockRejectedValue(new Error('still offline'))
    const result = await getHandler('codeServer:retry')({})
    expect(result).toEqual({ error: 'still offline' })
  })

  it('releases on request', async () => {
    await getHandler('codeServer:release')({})
    expect(serviceMock.release).toHaveBeenCalled()
  })
})
