import { createConnection } from 'node:net'

/** localhost:port 가 열려있으면 true(대시보드/서버 실행중 판정). */
export function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
