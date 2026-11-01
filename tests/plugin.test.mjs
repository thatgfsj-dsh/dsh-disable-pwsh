/**
 * `dsh-disable-pwsh` 的单元测试：用假 ctx 覆盖「何时移除 / 何时不动 / 失败怎么办」。
 *
 * 假 harness 复现了真实 `restrict` 的两条关键语义：
 *   1) restriction 落层后，该 agent 的工具目录里就没有 pwsh 了；
 *   2) `restrict()` 会**同步** emit `tools/change`（ScopedLayers.onChange），
 *      于是插件自己的处理器会被重入 —— 幂等与递归都要靠这个语义来验。
 *
 * 这些用例不依赖真实 DSH 安装；真实组合下的行为由 `scripts/smoke.mjs` 验证。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name as pluginName } from '../index.js'

/**
 * 造一个最小的假 Context：事件表、effect 栈、tools/agents 服务与 logger。
 * @param {{ visible?: Set<object>, restrictImpl?: Function, agents?: object[], getImpl?: Function }} [options] - 定制点。
 * @returns {object} 测试句柄。
 */
function createHarness(options = {}) {
  const listeners = new Map()
  const warnings = []
  const restrictions = []
  const effects = []
  const visible = options.visible ?? new Set()
  const agents = options.agents ?? []
  const restrictCalls = []
  const listenerOptions = new Map()
  let depth = 0
  let maxDepth = 0

  const emit = (event, payload) => {
    depth += 1
    maxDepth = Math.max(maxDepth, depth)
    try {
      for (const entry of listeners.get(event) ?? []) entry.handler(payload)
    } finally {
      depth -= 1
    }
  }

  const ctx = {
    on(event, handler, opts) {
      const list = listeners.get(event) ?? []
      list.push({ handler, opts })
      listeners.set(event, list)
      listenerOptions.set(event, opts)
    },
    effect(effect) {
      const disposer = effect()
      effects.push(disposer)
      return disposer
    },
    tools: {
      get(toolName, agent) {
        if (options.getImpl !== undefined) return options.getImpl(toolName, agent)
        if (toolName !== 'pwsh') return undefined
        return visible.has(agent) ? { name: 'pwsh' } : undefined
      },
    },
    agents: {
      list: () => [...agents],
    },
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
    },
  }

  const makeAgent = () => {
    const agent = {
      id: `agent-${restrictions.length + restrictCalls.length + 1}`,
      ctx: {
        tools: {
          restrict(filter) {
            if (options.restrictImpl !== undefined) return options.restrictImpl(filter, agent)
            restrictCalls.push(filter)
            // 真实语义 1：restriction 落层 → 该 agent 看不到 pwsh 了。
            visible.delete(agent)
            // 真实语义 2：落层会同步 emit tools/change，插件自己的处理器被重入。
            emit('tools/change', {})
            const disposer = () => {}
            restrictions.push(disposer)
            return disposer
          },
        },
      },
    }
    visible.add(agent)
    return agent
  }

  const teardown = () => {
    for (const disposer of effects) disposer()
  }

  return {
    ctx,
    emit,
    warnings,
    restrictions,
    restrictCalls,
    effects,
    teardown,
    makeAgent,
    agents,
    visible,
    listenerOptions,
    get maxDepth() {
      return maxDepth
    },
  }
}

test('插件导出契约：名字与 inject', () => {
  assert.equal(pluginName, 'disable-pwsh')
  assert.deepEqual(inject, ['tools', 'agents'])
})

test('三个监听器都带 global 选项（不被 scope 过滤，覆盖全部 agent）', () => {
  const harness = createHarness()
  apply(harness.ctx)

  for (const event of ['agent/created', 'agent/disposed', 'tools/change']) {
    assert.deepEqual(harness.listenerOptions.get(event), { global: true }, event)
  }
})

test('新 agent 可见 pwsh 时，按 deny 名单移除一次', () => {
  const harness = createHarness()
  apply(harness.ctx)

  const agent = harness.makeAgent()
  harness.emit('agent/created', { agent })

  assert.deepEqual(harness.restrictCalls, [{ deny: ['pwsh'] }])
})

test('同一个 agent 重复创建事件不会重复注册 restriction', () => {
  const harness = createHarness()
  apply(harness.ctx)

  const agent = harness.makeAgent()
  harness.emit('agent/created', { agent })
  harness.emit('agent/created', { agent })
  harness.emit('tools/change', {})

  assert.equal(harness.restrictCalls.length, 1)
})

test('pwsh 不可见时不动手（避免 unknown-tool 抛错）', () => {
  const harness = createHarness()
  apply(harness.ctx)

  const agent = harness.makeAgent()
  harness.visible.delete(agent)
  harness.emit('agent/created', { agent })

  assert.deepEqual(harness.restrictCalls, [])
  assert.deepEqual(harness.warnings, [])
})

test('工具在 agent 创建后才出现时，由 tools/change 补上移除', () => {
  const harness = createHarness()
  apply(harness.ctx)
  const agent = harness.makeAgent()
  harness.visible.delete(agent)
  harness.agents.push(agent)

  assert.deepEqual(harness.restrictCalls, [])

  harness.visible.add(agent)
  harness.emit('tools/change', {})

  assert.deepEqual(harness.restrictCalls, [{ deny: ['pwsh'] }])
})

test('restrict 抛错只记 warning，不让 agent 创建失败，并在下次变更时重试', () => {
  let attempts = 0
  const harness = createHarness({
    restrictImpl() {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return () => {}
    },
  })
  apply(harness.ctx)

  const agent = harness.makeAgent()
  harness.agents.push(agent)
  assert.doesNotThrow(() => harness.emit('agent/created', { agent }))
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /boom/)

  harness.emit('tools/change', {})
  assert.equal(attempts, 2)
})

test('tools 服务不可用时也不让 agent 创建失败（异常不冒泡进串行派发）', () => {
  const harness = createHarness({
    getImpl() {
      throw new Error('cannot get required service "tools" in inactive context')
    },
  })
  apply(harness.ctx)

  const agent = harness.makeAgent()
  harness.agents.push(agent)

  assert.doesNotThrow(() => harness.emit('agent/created', { agent }))
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /inactive context/)
  assert.deepEqual(harness.restrictCalls, [])
})

test('插件卸载时回收所有 restriction', () => {
  const harness = createHarness()
  apply(harness.ctx)

  const disposers = []
  const agentA = harness.makeAgent()
  const agentB = harness.makeAgent()
  // 换成记录调用的 restrict，验证 teardown 会逐个调用 disposer。
  for (const agent of [agentA, agentB]) {
    agent.ctx.tools.restrict = () => {
      let disposed = false
      const disposer = () => {
        disposed = true
      }
      disposers.push(() => disposed)
      return disposer
    }
  }
  harness.emit('agent/created', { agent: agentA })
  harness.emit('agent/created', { agent: agentB })

  harness.teardown()

  assert.equal(disposers.length, 2)
  for (const isDisposed of disposers) assert.equal(isDisposed(), true)
})

test('插件加载时补禁用已存在的会话', () => {
  const harness = createHarness()
  const agent = harness.makeAgent()
  harness.agents.push(agent)

  apply(harness.ctx)

  assert.deepEqual(harness.restrictCalls, [{ deny: ['pwsh'] }])
})

test('agent 销毁后释放记录，pwsh 再次可见时还能禁用', () => {
  const harness = createHarness()
  apply(harness.ctx)

  const agent = harness.makeAgent()
  harness.emit('agent/created', { agent })
  assert.equal(harness.restrictCalls.length, 1)

  harness.emit('agent/disposed', { agent })

  // 新的一轮：pwsh 又可见了（restriction 随 agent 的 scope 一起没了）。
  harness.visible.add(agent)
  harness.emit('agent/created', { agent })
  assert.equal(harness.restrictCalls.length, 2)
})

test('多个会话同时需要禁用时每个只禁一次，restrict 的同步重入不递归', () => {
  const harness = createHarness()
  apply(harness.ctx)

  const agents = [harness.makeAgent(), harness.makeAgent(), harness.makeAgent()]
  for (const agent of agents) harness.emit('agent/created', { agent })

  assert.equal(harness.restrictCalls.length, 3)

  // 再来一轮变更：仍然幂等。
  harness.emit('tools/change', {})
  assert.equal(harness.restrictCalls.length, 3)

  // 嵌套深度：agent/created → restrict → tools/change → disableEverywhere，
  // 不该再往下钻（否则每个会话一层，N 个会话就是 N 层递归）。
  assert.ok(harness.maxDepth <= 3, `嵌套深度过大：${harness.maxDepth}`)
})
