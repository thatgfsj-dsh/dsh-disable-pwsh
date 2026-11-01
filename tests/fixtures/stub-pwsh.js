/**
 * 冒烟测试用的假 `pwsh` 工具：不依赖任何 `@deepseek-ai/*` 包，也不加载真实
 * PowerShell 执行器。用来在任意平台验证「工具被移除 / 未被移除」。
 */
export const name = 'pwsh-stub'
export const inject = ['tools']

/** 注册一个名字为 `pwsh` 的假工具。 */
export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'pwsh',
      description: '冒烟测试用假 pwsh 工具',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: () => [{ type: 'text', text: 'stub' }],
      },
      async execute() {
        return 'stub'
      },
    }),
  )
}
