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
  /** agent → 该 agent 上这次 restriction 的 disposer。 */
  const restrictions = new Map()

  /** 让一个 agent 的工具目录里不再有 `pwsh`（幂等）。 */
  const disableFor = (agent) => {
    if (restrictions.has(agent)) return
    // 工具不可见时（非 win32、预设已关闭、或根本没装 shell 执行器）不能调用
    // restrict：它会对未知工具名抛错，从而让整个 agent/created 监听器失败。
    if (ctx.tools.get(TOOL_NAME, agent) === undefined) return
    try {
      restrictions.set(agent, agent.ctx.tools.restrict({ deny: [TOOL_NAME] }))
    } catch (error) {
      ctx.logger.warn(
        `dsh-disable-pwsh: 无法为会话 ${agent.id} 禁用 ${TOOL_NAME}：${error?.message ?? error}`,
      )
    }
  }

  /** 覆盖所有活着的 agent（热加载、预设切换、工具后注册都会走到这里）。 */
  const disableEverywhere = () => {
    for (const agent of ctx.agents.list()) disableFor(agent)
  }

  // restriction 同时由 agent.ctx 拥有；插件自己再持一份 disposer，才能覆盖
  // 「插件先卸载」与「agent 先销毁」两种回收顺序。
  ctx.effect(() => () => {
    for (const dispose of restrictions.values()) dispose()
    restrictions.clear()
  })

  ctx.on('agent/created', ({ agent }) => disableFor(agent))
  ctx.on('agent/disposed', ({ agent }) => restrictions.delete(agent))
  ctx.on('tools/change', disableEverywhere)

  // 插件在会话已存在之后才加载（热更新、后装）时，也要补上禁用。
  disableEverywhere()
}
