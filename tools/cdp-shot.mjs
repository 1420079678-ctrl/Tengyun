/**
 * Capture a running Chromium/Electron page through the DevTools protocol.
 * PrintWindow returns black for these windows once they are occluded or the GPU
 * surface is not composited, so screenshots for verification come from here.
 *
 * Usage: node tools/cdp-shot.mjs <port> <out.png> [urlSubstring]
 */
import { writeFileSync } from 'node:fs'

const [port, out, filter] = process.argv.slice(2)
if (!port || !out) {
  console.error('usage: node tools/cdp-shot.mjs <port> <out.png> [urlSubstring]')
  process.exit(2)
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const targets = list.filter(item => item.type === 'page' && (!filter || item.url.includes(filter)))
if (!targets.length) {
  console.error('no matching page target; available:', list.map(item => `${item.type} ${item.url}`).join('\n'))
  process.exit(1)
}

const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let id = 0
const pending = new Map()
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const next = ++id
  pending.set(next, { resolve, reject })
  socket.send(JSON.stringify({ id: next, method, params }))
})

const metrics = await send('Page.getLayoutMetrics')
const width = Math.ceil(metrics.cssVisualViewport?.clientWidth || metrics.layoutViewport.clientWidth)
const height = Math.ceil(metrics.cssVisualViewport?.clientHeight || metrics.layoutViewport.clientHeight)
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 0, width, height, scale: 2 },
  captureBeyondViewport: false,
})
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(`captured ${width}x${height} @2x -> ${out} (${targets[0].url})`)
process.exit(0)
