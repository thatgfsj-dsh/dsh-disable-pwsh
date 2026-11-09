#!/usr/bin/env node
/**
 * 实机截图：自建一份**临时** DSH 实例（独立 DSH_HOME + 独立端口），装上本插件，
 * 用 headless Chrome 打开 Web UI，截两张图：
 *
 *   1. docs/images/plugin-inventory-tool-pwsh.png
 *      设置 → 内置插件 → 展开 tool-pwsh 卡片（完整名称 / 来自 / 配置状态 / 禁用条件）。
 *   2. docs/images/plugin-installed.png
 *      侧栏「插件」面板 → 已安装插件 → 本插件卡片。
 *
 * 刻意**不使用主端口 3080**（那是本机正在跑的 DSH 实例）；默认用 3099，可用
 * `--port` 改。整个过程只碰临时目录，跑完即删。
 *
 * 用法：
 *   node scripts/screenshot.mjs                 # 全流程（自建实例 + 截图）
 *   node scripts/screenshot.mjs --keep          # 保留临时目录与实例日志
 *   node scripts/screenshot.mjs --url http://127.0.0.1:3099 --token <TOKEN>
 *                                           # 对已有实例截图（不启动、不安装）
 *
 * 依赖：PATH 里有 google-chrome（或 --chrome 指定）、dsh、pnpm。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluate, launchChrome, screenshot, waitFor } from './lib/cdp.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const imagesDir = join(repoRoot, 'docs', 'images')

const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const keep = argv.includes('--keep')
const port = Number(flag('--port', '3099'))
const chromeBinary = flag('--chrome', 'google-chrome')
const existingUrl = flag('--url')
const existingToken = flag('--token')

if (port === 3080) {
  console.error('拒绝使用主端口 3080（那是本机正在跑的实例）：换一个端口。')
  process.exit(1)
}

/** 起一个后台进程并收集它的输出。 */
function start(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  return { child, read: () => output }
}

/** 跑一条命令并等它结束。 */
async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'ignore', ...options })
  const code = await new Promise((resolve) => child.on('exit', (status) => resolve(status)))
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code})`)
}

const workdir = mkdtempSync(join(tmpdir(), 'dsh-disable-pwsh-shot-'))
const dshHome = join(workdir, 'dsh-home')
const dshEnv = { ...process.env, DSH_HOME: dshHome }
let server = undefined
let page = undefined

try {
  let baseUrl = existingUrl
  let token = existingToken

  if (existingUrl === undefined) {
    console.log(`· 临时 DSH_HOME：${dshHome}`)
    console.log('· 初始化 web profile …')
    await run('dsh', ['--profile', 'web', '--dump-config'], { env: dshEnv, cwd: workdir })

    console.log('· 安装本插件 …')
    await run('dsh', ['plugin', '--profile', 'web', 'add', repoRoot], { env: dshEnv, cwd: workdir })

    console.log(`· 启动 dsh web（端口 ${port}，不是主端口 3080）…`)
    server = start('dsh', ['web', '--port', String(port), '--host', '127.0.0.1', '--no-open'], {
      env: dshEnv,
      cwd: workdir,
    })
    const url = await waitFor(
      () => server.read().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=(\S+)/)?.[0],
      { timeout: 120000, label: 'dsh web startup' },
    )
    baseUrl = url.slice(0, url.indexOf('?'))
    token = url.slice(url.indexOf('token=') + 'token='.length)
    console.log(`· 实例就绪：${baseUrl}`)
    // dsh 打印 URL 与真正开始监听之间有一点间隔，等一会儿再开浏览器。
    await new Promise((resolve) => setTimeout(resolve, 8000))
  }

  if (token === undefined) throw new Error('缺少 token：用 --token 或让脚本自建实例')

  mkdirSync(imagesDir, { recursive: true })
  const chrome = await launchChrome({ port: 9333, binary: chromeBinary })
  try {
    // 注意：baseUrl 自带结尾斜杠，拼 "?token=" 时不要再加一个斜杠
    // （`//?token=` 会被服务端当成未知路径，直接 400）。
    const fullUrl = new URL(`?token=${token}`, baseUrl).href
    page = await chrome.newPage()
    await page.send('Network.enable')
    page.on('Network.responseReceived', (params) => {
      if (params.type === 'Document') console.log(`· 文档响应：${params.response.status} ${params.response.url}`)
    })
    await page.send('Page.navigate', { url: fullUrl })

    /** 按可见文字点一个按钮。 */
    const clickButton = async (label) => {
      const result = await evaluate(
        page,
        `(() => {
          const b = [...document.querySelectorAll('button,[role=menuitem],[role=tab]')].find(x => ((x.getAttribute('aria-label') || x.textContent || '').trim()) === ${JSON.stringify(label)})
          if (!b) return 'not-found'
          b.click(); return 'clicked'
        })()`,
      )
      if (result === 'not-found') throw new Error(`找不到按钮：${label}`)
      return result
    }

    /** 等某个按钮出现再点（Web UI 是异步渲染，直接点容易扑空）。 */
    const waitAndClick = async (label, timeout = 30000) => {
      await waitFor(
        async () =>
          (await evaluate(
            page,
            `!![...document.querySelectorAll('button,[role=menuitem],[role=tab]')].find(x => ((x.getAttribute('aria-label') || x.textContent || '').trim()) === ${JSON.stringify(label)})`,
          )) === true,
        { timeout, label: `按钮「${label}」` },
      )
      return clickButton(label)
    }

    // 页面骨架就绪（侧栏出现）再继续。
    await waitFor(
      async () =>
        (await evaluate(
          page,
          `!![...document.querySelectorAll('button')].find(x => ((x.getAttribute('aria-label') || x.textContent || '').trim()) === '新建会话')`,
        )) === true,
      { timeout: 60000, label: 'web ui ready' },
    )
    console.log('· Web UI 就绪')

    // 预览版说明：弹窗可能比页面骨架晚一点挂载，不能只点一次就假定关掉了。
    // 这里要求「连续一段时间看不到『继续』」才算关闭，避免弹窗晚到把后面的
    // 账号菜单与「设置」按钮挡住（实测偶发：点早了 → 弹窗仍在 → 设置超时）。
    const hasPreviewDismiss = () =>
      evaluate(
        page,
        `!![...document.querySelectorAll('button')].find(x => ((x.getAttribute('aria-label') || x.textContent || '').trim()) === '继续')`,
      )
    const dismissPreview = async (timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      let absentStreak = 0
      while (Date.now() < deadline && absentStreak < 5) {
        if ((await hasPreviewDismiss()) === true) {
          absentStreak = 0
          await evaluate(
            page,
            `(() => { const b=[...document.querySelectorAll('button')].find(x=>((x.getAttribute('aria-label')||x.textContent||'').trim())==='继续'); if(b) b.click(); return 1 })()`,
          )
          await new Promise((resolve) => setTimeout(resolve, 500))
        } else {
          absentStreak += 1
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
      }
    }
    await dismissPreview()

    // —— 图 1：设置 → 内置插件 → 展开 tool-pwsh 卡片 ——
    // 账号菜单偶尔要等头像渲染完才会出现；一次没打开「设置」就重开菜单重试。
    let settingsOpened = false
    for (let attempt = 0; attempt < 3 && !settingsOpened; attempt += 1) {
      await dismissPreview(3000)
      await evaluate(
        page,
        `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').includes('账号菜单')); if(b) b.click(); return 1 })()`,
      )
      try {
        await waitAndClick('设置', 12000)
        settingsOpened = true
      } catch (error) {
        if (attempt === 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await waitAndClick('内置插件')
    await new Promise((resolve) => setTimeout(resolve, 4500))

    const cardClicked = await evaluate(
      page,
      `(() => {
        const hit = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('tool-pwsh'))
        if (!hit) return 'not-found'
        hit.click(); return 'clicked'
      })()`,
    )
    if (cardClicked === 'not-found') throw new Error('插件库存里找不到 tool-pwsh 卡片')
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const inventoryText = await evaluate(page, 'document.body.innerText')
    if (!inventoryText.includes('tool-pwsh')) throw new Error('页面里没有 tool-pwsh')
    // 展开后的卡片要能看到完整名称、来源与禁用条件，否则截图没有说服力。
    for (const expected of ['@deepseek-ai/dsh-tool-pwsh', '完整名称', '禁用条件']) {
      if (!inventoryText.includes(expected)) throw new Error(`插件库存卡片里没有「${expected}」`)
    }

    const clip = await evaluate(
      page,
      `(() => {
        const hit = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('tool-pwsh'))
        const card = hit?.closest('li') ?? hit?.parentElement?.parentElement
        if (!card) return null
        const r = card.getBoundingClientRect()
        return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 }
      })()`,
    )
    await screenshot(page, join(imagesDir, 'plugin-inventory-tool-pwsh.png'), clip ?? undefined)
    console.log(`✔ ${join('docs', 'images', 'plugin-inventory-tool-pwsh.png')}`)

    // —— 图 2：侧栏「插件」面板 → 已安装插件 ——
    await evaluate(
      page,
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>((x.getAttribute('aria-label')||x.textContent||'').trim())==='关闭'); if(b) b.click(); return 1 })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await waitAndClick('插件')
    await new Promise((resolve) => setTimeout(resolve, 3500))

    const panelText = await evaluate(page, 'document.body.innerText')
    if (!panelText.includes('禁用 pwsh')) throw new Error('插件面板里没有本插件卡片')

    const installedClip = await evaluate(
      page,
      `(() => {
        const hit = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && (el.textContent||'').trim() === '禁用 pwsh')
        const card = hit?.closest('li') ?? hit?.parentElement?.parentElement
        if (!card) return null
        const r = card.getBoundingClientRect()
        return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 }
      })()`,
    )
    await screenshot(page, join(imagesDir, 'plugin-installed.png'), installedClip ?? undefined)
    console.log(`✔ ${join('docs', 'images', 'plugin-installed.png')}`)
  } catch (error) {
    // 诊断必须在关掉 Chrome 之前做，否则 socket 已经关了，evaluate 永远不返回。
    try {
      console.error(
        '页面按钮：',
        await evaluate(
          page,
          "JSON.stringify([...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 40))",
        ),
      )
      console.error('页面正文：', (await evaluate(page, 'document.body.innerText')).slice(0, 400))
    } catch (diagnosticError) {
      console.error('诊断失败：', diagnosticError.message)
    }
    throw error
  } finally {
    await chrome.close()
  }

  console.log('\n截图完成')
} catch (error) {
  console.error(`截图失败：${error.message}`)
  if (server !== undefined) console.error(server.read().split('\n').slice(-15).join('\n'))
  process.exitCode = 1
} finally {
  if (server !== undefined) server.child.kill('SIGTERM')
  if (keep) {
    console.log(`临时目录保留：${workdir}`)
  } else {
    rmSync(workdir, { recursive: true, force: true })
  }
}
