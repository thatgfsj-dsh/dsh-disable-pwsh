# 更新日志

## v0.1.0（2026-11-01）

首个版本。

- 宿主平面：bundle patch 把顶层 `tool-pwsh` 行 `disabled: true`（headless / acp / sdk 等直接组合工具行的 profile 立刻生效）。
- 预设平面：Host 插件在 `agent/created` 时对每个 agent 执行 `tools.restrict({ deny: ['pwsh'] })`（web 的 standard / cordis / 自建预设、子代理、PTC `run_code` 的 SDK 全部看不到 `pwsh`）。
- 幂等与容错：重复事件不重复注册；`pwsh` 不存在时不做任何事；`restrict` 抛错只记 warning 并在下次 `tools/change` 重试；插件卸载时回收 restriction；热更新/后装时补禁用已存在会话。
- 测试：9 项单元测试 + 4 项真实 DSH 冒烟；Linux 与 Wine（Windows Node 24.21 + DSH 0.2.1-rc.2）两端实测，含「真实 pwsh 工具被移除」。
