/**
 * dsh-disable-pwsh — 无条件禁用 `pwsh` 工具。
 *
 * DSH 自带的 `tool-pwsh` 行用平台条件开关：
 *
 *     disabled: !!js process.platform !== 'win32'
 *
 * 也就是说，在 Windows（包括 Wine 里的 Windows Node）上，会话默认拿到 `pwsh`
 * 工具。本插件不关心平台、预设、会话与子代理，只要 `pwsh` 出现在某个 agent 的
 * 工具目录里，就用 `ctx.tools.restrict({ deny: ['pwsh'] })` 把它移除。
 *
 * 为什么不是「把预设里的行改成 disabled: true」：宿主 bundle 的 patch 只能按顶层
 * entry id 覆盖整行 config，够不到 `@deepseek-ai/dsh-agent-preset` 的
 * `config.plugins` 数组里那一行；改预设等于把整份预设配置复制一遍，上游一升级就
 * 烂。所以宿主平面的行禁用交给 `cordis.patch.yml`（顶层行可以直接 `disabled`），
 * 预设平面（web）的行由本插件的运行时 restriction 兜底。
 *
 * 前提：`pwsh` 由工具插件注册在**全局层**（`dsh-tool-pwsh` 与
 * `dsh-tool-pwsh-persistent` 都注册这个名字）。`restrict` 只能过滤继承来的工具，
 * 对某个 scope 自己那一层注册的工具无效——若哪天上游改成把 `pwsh` 注册进 agent
 * 自己的层，本插件的 restriction 会被 `restrict` 的 unknown-tool 校验挡下，
 * 此时只会留下一条 warning，而 `pwsh` 依然可见。
 *
 * @module dsh-disable-pwsh
 */

/** 要禁用的工具名（`@deepseek-ai/dsh-tool-pwsh` 与 `...-persistent` 都注册这个名字）。 */
const TOOL_NAME = 'pwsh'

/** Cordis 插件名。 */
export const name = 'disable-pwsh'

/** `tools` 用来删除工具；`agents` 用来覆盖插件热加载时已经活着的会话。 */
export const inject = ['tools', 'agents']

/**
 * 对每个 agent 移除一次 `pwsh`，并持有可回收的 restriction。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  /** agent → 该 agent 上这次 restriction 的 disposer（禁用中的占位为 `null`）。 */
  const restrictions = new Map()

  /** 扫描是否正在进行中（`restrict` 会同步触发 `tools/change`，需要防重入）。 */
  let sweeping = false

  /**
   * 让一个 agent 的工具目录里不再有 `pwsh`（幂等）。
   *
   * 这里的所有语句都必须自己吞掉异常：`agent/created` 是串行派发，监听器抛错会
   * 顺着 `announce()` → `publish()` 冒泡出去，直接让会话创建失败。
   * @param agent - 目标 agent。
   */
  const disableFor = (agent) => {
    if (restrictions.has(agent)) return
    try {
      // 工具不可见时（非 win32、预设已关闭、或根本没装 shell 执行器）不能调用
      // restrict：它会对未知工具名抛错。
      if (ctx.tools.get(TOOL_NAME, agent) === undefined) return
      // 先占位再调用：restrict() 会同步 emit `tools/change`，重入时若还没占位，
      // 同一个 agent 会被重复禁用（递归 + O(N²)）。
      restrictions.set(agent, null)
      const dispose = agent.ctx.tools.restrict({ deny: [TOOL_NAME] })
      restrictions.set(agent, dispose)
    } catch (error) {
      restrictions.delete(agent)
      ctx.logger.warn(
        `dsh-disable-pwsh: 无法为会话 ${agent.id} 禁用 ${TOOL_NAME}：${error?.message ?? error}`,
      )
    }
  }

  /** 覆盖所有活着的 agent（热加载、预设切换、工具后注册都会走到这里）。 */
  const disableEverywhere = () => {
    if (sweeping) return
    sweeping = true
    try {
      for (const agent of ctx.agents.list()) disableFor(agent)
    } catch (error) {
      ctx.logger.warn(`dsh-disable-pwsh: 扫描会话失败：${error?.message ?? error}`)
    } finally {
      sweeping = false
    }
  }

  // restriction 本身归 agent.ctx 的 fiber 所有：agent 先销毁时由它回收，插件这边
  // 的 disposer 不会也不必再调用；插件先卸载时则由下面的 effect 兜底回收。
  ctx.effect(() => () => {
    for (const dispose of restrictions.values()) dispose?.()
    restrictions.clear()
  })

  // `global: true`：即使本插件被写进某个预设的 config.plugins，监听器也不会被
  // scope 过滤掉，仍然覆盖全部 agent。
  ctx.on(
    'agent/created',
    ({ agent }) => {
      try {
        disableFor(agent)
      } catch (error) {
        ctx.logger.warn(`dsh-disable-pwsh: 处理新会话失败：${error?.message ?? error}`)
      }
    },
    { global: true },
  )
  ctx.on(
    'agent/disposed',
    ({ agent }) => restrictions.delete(agent),
    { global: true },
  )
  ctx.on('tools/change', disableEverywhere, { global: true })

  // 插件在会话已存在之后才加载（热更新、后装）时，也要补上禁用。
  disableEverywhere()
}
