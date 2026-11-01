# 更新日志

## v0.1.1（2026-11-02）

发布前加固（对抗性代码复核后的修复）+ 实机截图。

- **健壮性**：把 `ctx.tools.get()` 挪进 `try` 范围，并给 `agent/created` 监听器再加一层兜底 —— 之前 `tools` 服务在热重载瞬间不可用时，异常会冒泡进串行派发，直接让会话创建失败。
- **防重入**：`restrict()` 会同步触发 `tools/change`，插件自己的处理器会被重入。现在先占位再落层，并给全量扫描加了重入闸门：递归深度从 O(会话数) 降到常数，单次变更的代价从 O(N²) 降到 O(N)。
- **覆盖范围**：三个监听器都加 `{ global: true }` —— 即使本插件被写进某个预设的 `config.plugins`，也不会被 scope 过滤掉，仍然覆盖全部 agent。
- **声明式半边的措辞与现实对齐**：`@deepseek-ai/dsh-tool-pwsh-persistent` 那条行（id `persistent-pwsh`）只存在于独立的 `dsh-sdk-minimal` bundle 与 web 的 `minimal` 预设里；顶层 patch 够不到预设里的行，而 `dsh-sdk-minimal` 不是常规 profile，所以没有写这条 patch（写了只会在其它 profile 留下一条 "entry not found" 警告）。那个 bundle 上仍由运行时那半边兜底。
- **测试**：假 harness 复现真实 `restrict` 语义（落层后工具不可见 + 同步 emit `tools/change`），新增「tools 服务不可用时不冒泡」「global 选项」「多会话不递归」三条用例，共 12 项；冒烟脚本改为断言**全部**探针行，探针改用 `setImmediate` 读可见性，不再依赖行的注册顺序。
- **文档**：新增 `docs/verification.md` 与实机截图（`docs/images/`），截图脚本 `scripts/screenshot.mjs` 可一键复现（自建临时实例 + 独立端口 3099，不碰主端口 3080）。

## v0.1.0（2026-11-01）

首个版本。

- 宿主平面：bundle patch 把顶层 `tool-pwsh` 行 `disabled: true`（headless / acp / sdk 等直接组合工具行的 profile 立刻生效）。
- 预设平面：Host 插件在 `agent/created` 时对每个 agent 执行 `tools.restrict({ deny: ['pwsh'] })`（web 的 standard / cordis / 自建预设、子代理、PTC `run_code` 的 SDK 全部看不到 `pwsh`）。
- 幂等与容错：重复事件不重复注册；`pwsh` 不存在时不做任何事；`restrict` 抛错只记 warning 并在下次 `tools/change` 重试；插件卸载时回收 restriction；热更新/后装时补禁用已存在会话。
- 测试：9 项单元测试 + 4 项真实 DSH 冒烟；Linux 与 Wine（Windows Node 24.21 + DSH 0.2.1-rc.2）两端实测，含「真实 pwsh 工具被移除」。
