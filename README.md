# dsh-disable-pwsh

**无条件禁用 DeepSeek Harness（DSH）的 `pwsh` 工具**：不挑平台、不挑预设、不挑会话，子代理同样生效。

> DSH 自带的 `tool-pwsh` 行用平台条件开关：`disabled: !!js process.platform !== 'win32'`。也就是说在 Windows（以及 Wine 里跑的 Windows Node）上，会话默认会拿到 `pwsh` 工具。本插件把它从模型可见的工具目录里移除——不管你在 Linux、macOS 还是 Windows，也不管会话用的是 `standard`、`cordis` 还是自建预设。

## 它做了什么

DSH 的工具有两个平面，本插件两层都管：

| 平面 | 例子 | 做法 |
|---|---|---|
| 宿主平面 | `headless` / `acp` / `sdk`（以及 web 里被 preset 取代前的宿主行） | `cordis.patch.yml` 直接把顶层 `tool-pwsh` 行 `disabled: true`：连工具注册都不会发生，工具插件附带的提示词小节也不会出现。 |
| 预设平面 | `web` 的 `standard` / `cordis` / 自建预设 | `index.js` 在 `agent/created` 时调用 `agent.ctx.tools.restrict({ deny: ['pwsh'] })`：模型目录、工具 schema、PTC `run_code` 的 SDK、子代理一律看不到 `pwsh`。 |

为什么预设平面不直接改预设配置：bundle 的 patch 只能按**顶层** entry id 覆盖整行 `config`，够不到 `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 数组里那一行；复制整份预设配置去改一个字段，上游一升级就会烂。运行时 `restrict` 是 DSH 官方「只能移除」的策略缝，语义正好。

其它行为：

- 插件热更新/后装时，**已经活着的会话**也会补上禁用（`ctx.agents.list()`）。
- 预设切换、工具后注册会触发 `tools/change`，插件会重试；已经禁用的会话不会重复注册。
- `pwsh` 本来就不存在时（非 win32、预设已关、没装 shell 执行器）**什么都不做**——不会因为 unknown-tool 抛错拖垮会话创建。
- 只禁用 `pwsh`；`bash`、`job_*`、文件工具等一概不碰。

## 安装

要求 DSH `>= 0.2.1-rc.2 < 0.3.0-0`（`engines.dsh`）。

```bash
# 本地目录（开发时推荐：改完文件重启 dsh 即可，不用重装）
dsh plugin --profile web add /absolute/path/to/dsh-disable-pwsh

# tarball
pnpm pack
dsh plugin --profile web add /absolute/path/to/dsh-disable-pwsh-0.1.0.tgz
```

装完**重启** `dsh web`（宿主行与 bundle patch 在启动时组合）。

Windows / Wine 注意：`dsh plugin add` 依赖插件管理器解析 `pnpm`。DSH `0.2.1-rc.2` 在 win32 上存在 pnpm 路径拼接问题（`C:\node24\\node_modules\pnpm\pnpm` 找不到），若命令失败，可手工放置：

```bat
:: 1) 把仓库拷进 profile 的 node_modules（路径按你的 DSH_HOME 改）
xcopy /E /I C:\path\to\dsh-disable-pwsh %DSH_HOME%\profiles\web\node_modules\dsh-disable-pwsh

:: 2) 在 %DSH_HOME%\profiles\web\package.json 里加：
::    "dependencies": { "dsh-disable-pwsh": "file:node_modules/dsh-disable-pwsh" }
::    "dsh": { "profile": { "bundles": [ ...原有项..., "dsh-disable-pwsh" ] } }
```

卸载：

```bash
dsh plugin --profile web remove dsh-disable-pwsh
```

## 验证

三级验证，全部可离线跑（不需要模型凭据——会话创建完成后的第一次请求会失败，这是预期，断言发生在 `agent/created`）：

```bash
# 1) 单元测试：何时移除 / 何时不动 / 失败怎么办（9 项）
node --test tests/plugin.test.mjs

# 2) 真实 DSH 冒烟（临时 DSH_HOME + headless profile，4 项）
node scripts/smoke.mjs

# 3) 装进 profile 后看组合树：应出现 "# == dsh-disable-pwsh" 与
#    "- id: tool-pwsh ... disabled: true"（带 "patched by dsh-disable-pwsh" 标注）
dsh --profile web --dump-config | grep -B2 -A3 "dsh-disable-pwsh"
```

Wine / 真 Windows 上还额外验证过「真实 `pwsh` 工具（不是假工具）被移除」，命令与结果见 [docs/verification.md](docs/verification.md)。

## 已知边界

- **插件库存卡片不会变成「已停用」**：卡片展示的是预设行自身的 `config.disabled`（win32 上原本就是启用、无禁用条件）。本插件在运行时移除工具，不改预设配置。想让卡片也显示已停用，只能整份覆盖预设行，代价是上游预设一升级就失配——不建议。
- **web 预设平面**（预设行）里，工具插件注册的短提示词小节（例如「非零退出码」那条）仍会出现在系统提示里。它描述的是退出码语义，不会误导模型去调不存在的工具；想要它一起消失只能在预设层关行（同上一條的代价）。宿主平面没有这个问题——行被禁用后小节根本不注册。
- 工具名固定为 `pwsh`（`@deepseek-ai/dsh-tool-pwsh` 与 `@deepseek-ai/dsh-tool-pwsh-persistent` 都注册这个名字）。
- 本插件不处理 `pwsh-sandbox` 执行器本身：禁用工具的职责止于工具目录，执行器是别的插件的事。

## 仓库

- 源码：<https://github.com/thatgfsj-dsh/dsh-disable-pwsh>
- 问题反馈：<https://github.com/thatgfsj-dsh/dsh-disable-pwsh/issues>
- 许可证：MIT
