import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeServerStatusEvent } from '../../../../shared/code-server-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  CODE_SERVER_PROGRESS_RUNTIME_CAPABILITY,
  CODE_SERVER_RUNTIME_CAPABILITY
} from '../../../../shared/code-server-runtime-contract'

const mocks = vi.hoisted<{
  statusListener?: (event: CodeServerStatusEvent) => void
  unsubscribeStatus: ReturnType<typeof vi.fn>
}>(() => ({ unsubscribeStatus: vi.fn() }))

vi.mock('../../../code-server/code-server-manager', () => ({
  CodeServerManager: class {
    onStatusChanged(listener: (event: CodeServerStatusEvent) => void) {
      mocks.statusListener = listener
      return mocks.unsubscribeStatus
    }

    async acquire(): Promise<{ port: number }> {
      mocks.statusListener?.({ status: 'installing', port: null, progress: 0.35 })
      mocks.statusListener?.({ status: 'starting', port: null })
      throw new Error('stop-after-status')
    }
  }
}))

import { CODE_SERVER_METHODS } from './code-server'

function runtime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The manager uses this object only as a WeakMap identity in these tests.
  return {} as OrcaRuntimeService
}

describe('codeServer.attach progress negotiation', () => {
  beforeEach(() => {
    mocks.statusListener = undefined
    vi.clearAllMocks()
  })

  it('streams installation status to clients that advertise progress support', async () => {
    const emit = vi.fn()

    await expect(
      CODE_SERVER_METHODS[0].handler(
        {},
        {
          runtime: runtime(),
          clientKind: 'runtime',
          clientCapabilities: [
            CODE_SERVER_RUNTIME_CAPABILITY,
            CODE_SERVER_PROGRESS_RUNTIME_CAPABILITY
          ],
          sendBinary: vi.fn(() => true),
          registerBinaryMessageHandler: vi.fn(() => vi.fn())
        },
        emit
      )
    ).rejects.toThrow('stop-after-status')

    expect(emit).toHaveBeenNthCalledWith(1, {
      type: 'status',
      status: 'installing',
      progress: 0.35
    })
    expect(emit).toHaveBeenNthCalledWith(2, { type: 'status', status: 'starting' })
    expect(mocks.unsubscribeStatus).toHaveBeenCalledOnce()
  })

  it('does not send unknown status events to older clients', async () => {
    const emit = vi.fn()

    await expect(
      CODE_SERVER_METHODS[0].handler(
        {},
        {
          runtime: runtime(),
          clientKind: 'runtime',
          clientCapabilities: [CODE_SERVER_RUNTIME_CAPABILITY],
          sendBinary: vi.fn(() => true),
          registerBinaryMessageHandler: vi.fn(() => vi.fn())
        },
        emit
      )
    ).rejects.toThrow('stop-after-status')

    expect(emit).not.toHaveBeenCalled()
  })
})
