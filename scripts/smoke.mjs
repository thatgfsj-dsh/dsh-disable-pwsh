#!/usr/bin/env node
/**
 * 真实 DSH 组合下的冒烟测试：验证「pwsh 工具确实从 agent 的工具目录消失」。
 *
 * 做法：在临时 DSH_HOME 里让 dsh 自建一份 headless profile，用 --patch 叠加
 * 探针与假 pwsh 工具（`tests/fixtures/`），然后跑 `dsh headless "ping"`。
 * 会话创建完成后模型请求会因缺少凭据而失败，这是预期行为——探针在
 * `agent/created` 阶段就已把可见性打到 stderr，脚本只断言探针行。
 *
 * 用法：
 *   node scripts/smoke.mjs            # 用 PATH 里的 dsh
 *   PWSH_SMOKE_BIN=/path/to/node \
 *     PWSH_SMOKE_BIN_ARGS='["/path/to/dsh/lib/bin.js"]' node scripts/smoke.mjs
 *   node scripts/smoke.mjs --keep     # 保留临时目录便于排查
 *
 * 环境变量（刻意不叫 DSH_*：DSH 会话里本身就有 DSH_PROFILE 等变量）：
 *   PWSH_SMOKE_BIN       dsh 可执行文件（默认 `dsh`；Wine 下可指向 `C:\node24\node.exe`）
 *   PWSH_SMOKE_BIN_ARGS  JSON 数组，拼在 PWSH_SMOKE_BIN 之后（Wine 下传 dsh 的 bin.js 路径）
 *   PWSH_SMOKE_PROFILE   profile 名（默认 `headless`）
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(repoRoot, 'tests', 'fixtures')
const keep = process.argv.includes('--keep')
const profile = process.env.PWSH_SMOKE_PROFILE ?? 'headless'
const dshBin = process.env.PWSH_SMOKE_BIN ?? 'dsh'
const dshBinArgs =
  process.env.PWSH_SMOKE_BIN_ARGS === undefined ? [] : JSON.parse(process.env.PWSH_SMOKE_BIN_ARGS)

const workdir = mkdtempSync(join(tmpdir(), 'dsh-disable-pwsh-smoke-'))
const dshHome = join(workdir, 'dsh-home')
mkdirSync(dshHome, { recursive: true })

/** 子进程环境：隔离 DSH_HOME，并剥掉当前 DSH 会话自己的 profile/session 变量。 */
function childEnv() {
  const env = { ...process.env, DSH_HOME: dshHome }
  delete env.DSH_PROFILE
  delete env.DSH_PROFILE_DIR
  delete env.DSH_SESSION_ID
  delete env.PWSH_SMOKE_BIN
  delete env.PWSH_SMOKE_BIN_ARGS
  delete env.PWSH_SMOKE_PROFILE
  return env
}

/** 用单引号包成 YAML 标量，Windows 路径里的反斜杠也不需要转义。 */
const yamlString = (value) => `'${String(value).replaceAll("'", "''")}'`
const url = (file) => pathToFileURL(file).href

const pluginRow = `    - id: smoke-disable-pwsh\n      name: ${yamlString(url(join(repoRoot, 'index.js')))}\n`
const stubRow = `    - id: smoke-pwsh-stub\n      name: ${yamlString(url(join(fixtures, 'stub-pwsh.js')))}\n`
const probeRow = `    - id: smoke-probe\n      name: ${yamlString(url(join(fixtures, 'probe.js')))}\n`

const overlays = {
  // 对照组：只有假 pwsh 工具 + 探针，必须看到 present。
  control: `- insert:\n${stubRow}${probeRow}`,
  // 插件在场：假 pwsh 工具必须被移除。
  // 探针用 setImmediate 延后读取可见性，所以这里不再依赖「插件行排在探针行之前」
  // 这个注册顺序假设（DSH 不保证行的激活顺序）。
  plugin: `- insert:\n${stubRow}${pluginRow}${probeRow}`,
  // 没有 pwsh 时插件不能因为 unknown-tool 抛错。
  'no-tool': `- insert:\n${pluginRow}${probeRow}`,
  // bundle patch 的声明式半边：真 tool-pwsh 行被禁用（win32 上有意义）。
  'host-row': `- id: tool-pwsh\n  disabled: true\n\n- insert:\n${probeRow}`,
}

const files = Object.fromEntries(
  Object.entries(overlays).map(([name, content]) => {
    const file = join(workdir, `${name}.yml`)
    writeFileSync(file, content)
    return [name, file]
  }),
)

/**
 * 跑一次 dsh headless，返回合并输出与全部探针报告。
 * @param {string} overlayFile - --patch 叠加层。
 * @returns {{ output: string, states: string[] }} 结果。
 */
function runCase(overlayFile) {
  const args = [
    ...dshBinArgs,
    '--profile',
    profile,
    '--patch',
    overlayFile,
    'ping',
  ]
  const result = spawnSync(dshBin, args, {
    cwd: workdir,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 180_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // 断言**全部**探针行：一次运行可能创建多个 agent（起始 agent / 子代理），
  // 只看第一条会漏判。
  const states = [...output.matchAll(/\[probe\] agent=\S+ pwsh=(present|absent)/g)].map((m) => m[1])
  return { output, states }
}

const cases = [
  ['control', 'present', '未装插件时假 pwsh 工具必须在工具目录里'],
  ['plugin', 'absent', '装插件后假 pwsh 工具必须被移除'],
  ['no-tool', 'absent', 'pwsh 不存在时插件不得因 unknown-tool 抛错，且探针照常工作'],
  ['host-row', 'absent', 'bundle patch 必须把宿主平面的 tool-pwsh 行禁用'],
]

let failed = 0
for (const [name, expected, why] of cases) {
  const { output, states } = runCase(files[name])
  const pass = states.length > 0 && states.every((state) => state === expected)
  const detail = pass
    ? ''
    : `\n  期望所有探针行都是 pwsh=${expected}，实际=[${states.join(', ') || '(没有探针输出)'}]\n  输出尾部：\n${output.split('\n').slice(-12).join('\n')}`
  console.log(`${pass ? '✔' : '✖'} ${name}: ${why}${detail}`)
  if (!pass) failed += 1
}

if (!keep) rmSync(workdir, { recursive: true, force: true })
else console.log(`临时目录保留：${workdir}`)

if (failed > 0) {
  console.error(`\n${failed} 个用例失败`)
  process.exit(1)
}
console.log('\n全部用例通过')
