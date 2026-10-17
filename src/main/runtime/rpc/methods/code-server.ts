import { connect } from 'node:net'
import { BrowserNetworkTunnelSession } from '../../../browser/browser-network-tunnel-session'
import { CodeServerManager } from '../../../code-server/code-server-manager'
import {
  CODE_SERVER_ATTACH_METHOD,
  CODE_SERVER_PROGRESS_RUNTIME_CAPABILITY,
  CODE_SERVER_RUNTIME_CAPABILITY,
  CodeServerAttachParams
} from '../../../../shared/code-server-runtime-contract'
import { defineStreamingMethod } from '../core'

const managers = new WeakMap<object, CodeServerManager>()
let nextTunnelGeneration = 1

function managerFor(runtime: object): CodeServerManager {
  let manager = managers.get(runtime)
  if (!manager) {
    manager = new CodeServerManager()
    managers.set(runtime, manager)
  }
  return manager
}

export const CODE_SERVER_METHODS = [
  defineStreamingMethod({
    name: CODE_SERVER_ATTACH_METHOD,
    permission: 'host-admin',
    params: CodeServerAttachParams,
    handler: async (
      _params,
      { runtime, clientKind, clientCapabilities, sendBinary, registerBinaryMessageHandler, signal },
      emit
    ) => {
      if (clientKind !== 'runtime' || !sendBinary || !registerBinaryMessageHandler) {
        throw new Error('authenticated_binary_code_server_tunnel_required')
      }
      if (!clientCapabilities?.includes(CODE_SERVER_RUNTIME_CAPABILITY)) {
        throw new Error('code_server_tunnel_capability_required')
      }
      const manager = managerFor(runtime)
      const sendsProgress = clientCapabilities?.includes(CODE_SERVER_PROGRESS_RUNTIME_CAPABILITY)
      const unsubscribeStatus = sendsProgress
        ? manager.onStatusChanged((event) => {
            if (event.status === 'installing' || event.status === 'starting') {
              emit({
                type: 'status',
                status: event.status,
                ...(event.progress === undefined ? {} : { progress: event.progress })
              })
            }
          })
        : () => {}
      let port: number
      try {
        const acquired = await manager.acquire()
        port = acquired.port
      } finally {
        unsubscribeStatus()
      }
      const tunnelGeneration = nextTunnelGeneration++
      let resolveClosed = (): void => {}
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve
      })
      const session = new BrowserNetworkTunnelSession({
        tunnelGeneration,
        connect: (target) => {
          if (target.host !== '127.0.0.1' || target.port !== port) {
            throw new Error('code_server_tunnel_target_rejected')
          }
          return connect({ host: target.host, port: target.port, allowHalfOpen: true })
        },
        sendBinary: (bytes) => sendBinary(bytes) !== false,
        onClose: () => {
          emit({ type: 'closed', tunnelGeneration })
          resolveClosed()
        }
      })
      const unregisterBinary = registerBinaryMessageHandler((bytes) => session.handleBinary(bytes))
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        unregisterBinary()
        session.close()
      }
      signal?.addEventListener('abort', cleanup, { once: true })
      try {
        if (signal?.aborted) {
          return
        }
        emit({ type: 'ready', tunnelGeneration, port })
        await closed
      } finally {
        signal?.removeEventListener('abort', cleanup)
        cleanup()
        manager.release()
      }
    }
  })
]
