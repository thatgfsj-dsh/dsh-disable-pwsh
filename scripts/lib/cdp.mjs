/**
 * 最小 CDP 客户端（Node 24 原生 WebSocket，无第三方依赖）。
 *
 * 只服务于截图脚本：启动 headless Chrome、打开页面、求值、截图。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 轮询直到条件成立。 */
export async function waitFor(fn, { timeout = 20000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** 启动 headless Chrome，返回一个已连接的 CDP 会话。 */
export async function launchChrome({ port = 9333, binary = 'google-chrome', width = 1680, height = 1050 } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-shot-chrome-'))
  const child = spawn(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      // 本机环境里可能挂着 SOCKS 代理，Chrome 会把 127.0.0.1 也丢给代理，
      // 结果连本地 DSH 实例都打不开。截图必须直连。
      '--no-proxy-server',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  const version = await waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`)
        return await res.json()
      } catch {
        return undefined
      }
    },
    { timeout: 20000, label: 'chrome devtools' },
  )

  const session = await connect(version.webSocketDebuggerUrl)
  session.close = async () => {
    try {
      session.socket.close()
    } catch {
      /* 已关闭 */
    }
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    rmSync(userDataDir, { recursive: true, force: true })
  }
  return session
}

/** 连上 CDP 浏览器端点。 */
async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const events = new Map()

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
      return
    }
    for (const listener of events.get(message.method) ?? []) listener(message.params)
  })

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })

  return {
    socket,
    send,
    /** 打开一个新标签页并附加，返回该页面的会话句柄。 */
    async newPage(url) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      const page = {
        sessionId,
        send: (method, params = {}) => send(method, params, sessionId),
        /** 最近一次导航的结果（失败时带 errorText）。 */
        navigation: undefined,
        /** 订阅 CDP 事件。 */
        on(method, listener) {
          const list = events.get(method) ?? []
          list.push(listener)
          events.set(method, list)
        },
      }
      await page.send('Page.enable')
      await page.send('Runtime.enable')
      if (url) {
        page.navigation = await page.send('Page.navigate', { url })
      }
      return page
    },
  }
}

/** 在页面里求值并取回 JSON 值。 */
export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

/** 截图并存盘；给了 clip 就只截那一块。 */
export async function screenshot(page, file, clip) {
  // 给了 clip 就允许超出视口：设置面板里的卡片可能比视口高，截全更好看。
  const params = { format: 'png', captureBeyondViewport: clip !== undefined }
  if (clip !== undefined) params.clip = { ...clip, scale: 1 }
  const { data } = await page.send('Page.captureScreenshot', params)
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}
