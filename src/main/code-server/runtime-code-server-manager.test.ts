import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachTimeoutMs: 0,
  attachCalls: 0,
  failFirstAttachForPairingChange: false,
  closeSubscription: vi.fn(),
  closeListener: vi.fn(async () => {}),
  closeTunnel: vi.fn()
}))

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/tmp/orca-test' })
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'environment-1' })
}))

vi.mock('../../shared/runtime-environments', () => ({
  getPreferredPairedRuntimeConnection: () => ({ endpoint: 'ws://127.0.0.1:1234' })
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    _connection: unknown,
    _method: string,
    _params: unknown,
    _timeoutMs: number,
    validateStatus: (status: unknown) => void
  ) => {
    validateStatus({
      ok: true,
      result: { capabilities: ['code-server.attach.v1'] }
    })
    return { ok: true, result: undefined }
  },
  subscribeRemoteRuntimeRequest: async (
    _connection: unknown,
    _method: string,
    _params: unknown,
    timeoutMs: number,
    callbacks: { onResponse: (response: unknown) => void }
  ) => {
    mocks.attachCalls += 1
    mocks.attachTimeoutMs = timeoutMs
    if (mocks.failFirstAttachForPairingChange && mocks.attachCalls === 1) {
      throw new Error('Runtime environment pairing changed; refresh and try again')
    }
    queueMicrotask(() => {
      callbacks.onResponse({
        ok: true,
        result: { type: 'status', status: 'installing', progress: 0.42 }
      })
      callbacks.onResponse({
        ok: true,
        result: { type: 'status', status: 'starting' }
      })
      callbacks.onResponse({
        ok: true,
        result: { type: 'ready', tunnelGeneration: 1, port: 43_915 }
      })
    })
    return {
      close: mocks.closeSubscription,
      sendBinary: () => true
    }
  }
}))

vi.mock('../browser/browser-network-tunnel-client', () => ({
  BrowserNetworkTunnelClient: class {
    open(): object {
      return {}
    }
    handleBinary(): void {}
    close(): void {
      mocks.closeTunnel()
    }
  }
}))

vi.mock('./code-server-tcp-tunnel', () => ({
  CodeServerTcpTunnel: class {
    async listen(): Promise<number> {
      return 53_891
    }
    close(): Promise<void> {
      return mocks.closeListener()
    }
  }
}))

import { RuntimeCodeServerManager } from './runtime-code-server-manager'

describe('RuntimeCodeServerManager', () => {
  beforeEach(() => {
    mocks.attachTimeoutMs = 0
    vi.clearAllMocks()
    mocks.attachCalls = 0
    mocks.failFirstAttachForPairingChange = false
  })

  it('allows enough time for a cold remote code-server install', async () => {
    const manager = new RuntimeCodeServerManager()

    await expect(manager.acquire({ executionHostId: 'runtime:environment-1' })).resolves.toEqual({
      port: 53_891
    })

    expect(mocks.attachTimeoutMs).toBe(5 * 60_000)
    await manager.shutdown()
  })

  it('forwards remote install and startup status to the renderer', async () => {
    const manager = new RuntimeCodeServerManager()
    const events: { status: string; progress?: number }[] = []
    manager.onStatusChanged((event) => events.push(event))

    await manager.acquire({ executionHostId: 'runtime:environment-1' })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'installing', progress: 0.42 }),
        expect.objectContaining({ status: 'starting' }),
        expect.objectContaining({ status: 'ready', port: 53_891 })
      ])
    )
    await manager.shutdown()
  })

  it('retries once after a runtime pairing changes during the first attach', async () => {
    mocks.failFirstAttachForPairingChange = true
    const manager = new RuntimeCodeServerManager()

    await expect(manager.acquire({ executionHostId: 'runtime:environment-1' })).resolves.toEqual({
      port: 53_891
    })

    expect(mocks.attachCalls).toBe(2)
    await manager.shutdown()
  })
})
