import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { pipeUpstreamToClient } from '../browser/remote-browser-socks-upstream'

export class CodeServerTcpTunnel {
  private readonly server: Server
  private readonly clients = new Set<Socket>()
  private closePromise: Promise<void> | null = null

  constructor(private readonly open: () => Promise<Duplex>) {
    this.server = createServer((socket) => this.accept(socket))
    this.server.maxConnections = 128
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.server.once('error', onError)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError)
        this.server.on('error', (error) => {
          console.warn(`[code-server] Local tunnel failed: ${error.message}`)
        })
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Code-server tunnel did not bind a TCP address'))
          return
        }
        resolve(address.port)
      })
    })
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeServer()
    return this.closePromise
  }

  private accept(socket: Socket): void {
    this.clients.add(socket)
    socket.pause()
    socket.once('close', () => this.clients.delete(socket))
    socket.once('error', () => socket.destroy())
    void this.open().then(
      (upstream) => {
        if (socket.destroyed) {
          upstream.destroy()
          return
        }
        socket.pipe(upstream)
        pipeUpstreamToClient(upstream, socket)
        upstream.once('error', () => socket.destroy())
        upstream.once('close', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
        socket.resume()
      },
      () => socket.destroy()
    )
  }

  private async closeServer(): Promise<void> {
    for (const socket of this.clients) {
      socket.destroy()
    }
    this.clients.clear()
    if (!this.server.listening) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}
