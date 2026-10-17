import { createServer, connect, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CodeServerTcpTunnel } from './code-server-tcp-tunnel'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

describe('CodeServerTcpTunnel', () => {
  it('bridges a loopback client to the supplied remote stream', async () => {
    const upstream = createServer((socket) => socket.pipe(socket))
    servers.push(upstream)
    await listen(upstream)
    const address = upstream.address()
    if (!address || typeof address === 'string') {
      throw new Error('Upstream server did not bind a TCP port')
    }

    const tunnel = new CodeServerTcpTunnel(
      () =>
        new Promise((resolve, reject) => {
          const socket = connect(address.port, '127.0.0.1', () => resolve(socket))
          socket.once('error', reject)
        })
    )
    const port = await tunnel.listen()
    const reply = await new Promise<string>((resolve, reject) => {
      const client = connect(port, '127.0.0.1', () => client.write('ping'))
      client.once('data', (chunk) => {
        resolve(chunk.toString())
        client.destroy()
      })
      client.once('error', reject)
    })

    expect(reply).toBe('ping')
    await tunnel.close()
  })
})

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}
