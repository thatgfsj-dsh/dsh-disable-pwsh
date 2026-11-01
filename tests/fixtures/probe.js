/**
 * 冒烟测试用的探针：在 agent 创建时把该 agent 工具目录里 `pwsh` 的可见性打到
 * stderr，供 `scripts/smoke.mjs` 断言。
 *
 * `agent/created` 是串行派发，监听器按注册顺序执行。探针必须插在
 * `dsh-disable-pwsh` 行之后，才能看到 restriction 生效后的目录。
 */
export const name = 'pwsh-probe'
export const inject = ['tools']

/** 监听 agent 创建并报告 pwsh 可见性。 */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const visible = ctx.tools.get('pwsh', agent) !== undefined
    console.error(`[probe] agent=${agent.id} pwsh=${visible ? 'present' : 'absent'}`)
  })
}
