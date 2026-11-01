/**
 * 冒烟测试用的探针：在 agent 创建时把该 agent 工具目录里 `pwsh` 的可见性打到
 * stderr，供 `scripts/smoke.mjs` 断言。
 *
 * 可见性用 `setImmediate` 延到宏任务里再读：这样整轮 `agent/created` 串行派发
 * 已经结束，读到的是最终目录，而不依赖「探针行必须排在插件行之后」这个注册
 * 顺序假设（DSH 不保证行的激活顺序）。
 */
export const name = 'pwsh-probe'
export const inject = ['tools']

/** 监听 agent 创建并报告 pwsh 可见性。 */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    setImmediate(() => {
      const visible = ctx.tools.get('pwsh', agent) !== undefined
      console.error(`[probe] agent=${agent.id} pwsh=${visible ? 'present' : 'absent'}`)
    })
  })
}
