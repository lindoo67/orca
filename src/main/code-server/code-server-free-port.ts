import { createServer } from 'node:net'

export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}
