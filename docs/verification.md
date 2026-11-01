# 验证记录

环境：

- **Linux**：Fedora + Node `v24.21.0` + DSH `0.2.1-rc.2`（`~/.npm-global` 安装，全局 CLI `dsh`）。
- **Wine / win32**：Wine（`~/.wine-nodetest` 前缀）+ Windows Node `24.21.0`（`C:\node24\node.exe`）+ Windows DSH `0.2.1-rc.2`（`C:\npm-global\node_modules\@deepseek-ai\dsh`）。

> Wine 侧全部跑在**独立 DSH_HOME**（`Z:\home\...\.scratch-pwsh\wine-home*`）里，没有碰机器上另一个正在使用的 DSH 实例与其 `C:\dsh-test-home`。

## 一、Linux

### 1. 单元测试

```bash
cd dsh-disable-pwsh
node --test tests/plugin.test.mjs
```

结果：`tests 9 / pass 9 / fail 0`。覆盖：导出契约、正常移除、重复事件幂等、工具不可见时不动手、`tools/change` 补课、`restrict` 抛错只 warning 且可重试、卸载回收、加载时补禁用、agent 销毁后可重来。

### 2. 真实 DSH 冒烟

```bash
node scripts/smoke.mjs
```

脚本自建临时 `DSH_HOME`（`dsh` 自动初始化 headless profile），用 `--patch` 叠加探针与假 `pwsh` 工具，跑 `dsh headless "ping"`。会话创建后的模型请求因缺少凭据而失败属预期；断言只看 `agent/created` 阶段的探针输出。

```
✔ control: 未装插件时假 pwsh 工具必须在工具目录里
✔ plugin: 装插件后假 pwsh 工具必须被移除
✔ no-tool: pwsh 不存在时插件不得因 unknown-tool 抛错，且探针照常工作
✔ host-row: bundle patch 必须把宿主平面的 tool-pwsh 行禁用

全部用例通过
```

### 3. 真实安装（`dsh plugin add`）

```bash
DSH_HOME=/tmp/inst-test dsh plugin --profile headless add /home/.../dsh-disable-pwsh
DSH_HOME=/tmp/inst-test dsh --profile headless --dump-config | grep -A2 tool-pwsh
```

组合树（关键两段）：

```yaml
# == @deepseek-ai/dsh-base, patched by dsh-disable-pwsh
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: true

# == dsh-disable-pwsh
- id: disable-pwsh
  name: dsh-disable-pwsh
```

再用探针 + 假工具跑一次：`[probe] agent=session-… pwsh=absent`（说明**安装后的 bundle** 里插件行真的激活并移除了工具）。

## 二、Wine / win32（真实 `pwsh` 工具）

Wine 下 `node` 把 stdout/stderr 接到 Linux 管道会 `EBADF`，所以经 `cmd /c` 重定向到文件。headless 不走端口、不碰对方 DSH_HOME：

```bash
export WINEPREFIX=$HOME/.wine-nodetest
env -u DISPLAY WINEDEBUG=-all DSH_HOME='Z:\home\thatgfsj\.scratch-pwsh\wine-home' \
  wine cmd /c 'C:\node24\node.exe C:\npm-global\node_modules\@deepseek-ai\dsh\lib\bin.js \
    --profile headless --patch Z:\...\wine-probe.yml ping > Z:\...\run.log 2>&1'
```

win32 上 `@deepseek-ai/dsh-base` 的 `tool-pwsh` 行本身是启用的（条件 `process.platform !== 'win32'` 为假），因此这里的探针看到的是**真实的** `@deepseek-ai/dsh-tool-pwsh`。

| 用例 | `--patch` 内容 | 探针结果 | 含义 |
|---|---|---|---|
| 对照 | 只插探针 | `pwsh=present` | win32 默认确实有 `pwsh` 工具 |
| 插件行 | 探针 + `index.js` 行 | `pwsh=absent` | 运行时 `restrict` 移除了真实工具 |
| bundle patch 等效 | `- id: tool-pwsh, disabled: true` + 探针 | `pwsh=absent` | 声明式半边也生效 |
| 强制启用 + 插件 | `- id: tool-pwsh, disabled: false` + 插件 + 探针 | `pwsh=absent` | 即使行被显式打开，插件仍移除 |
| 手工安装 bundle（默认） | profile 里放包 + bundles 列表 + 只插探针 | `pwsh=absent` | 安装形态下 bundle patch 生效 |
| 手工安装 bundle + 强制启用 | 同上 + `disabled: false` | `pwsh=absent` | 安装形态下插件半边生效 |

手工安装形态（对应 README 里 Windows 的 pnpm 兜底）：

```text
%DSH_HOME%\profiles\headless\node_modules\dsh-disable-pwsh\   ← 包目录
%DSH_HOME%\profiles\headless\package.json
  dependencies: { "dsh-disable-pwsh": "file:node_modules/dsh-disable-pwsh" }
  dsh.profile.bundles: [ ..., "dsh-disable-pwsh" ]
```

## 三、未覆盖

- **web 预设平面的真机 UI 验证**：需要浏览器/Web 会话驱动（`/api/remote.mux` 是 WebSocket RPC），本次未自动化。预设工具注册在 agent 作用域的祖先层，`tools.restrict` 的过滤发生在继承层（`view()` 对 global 与祖先层用同一套 `layers.every(admits)` 判定），与已验证的宿主平面是同一个代码路径；手工验证方式见 README「验证」第 3 步 + 在 Web 新会话里看模型工具列表。
- DSH `0.2.0.x`：未测，`engines.dsh` 因此只声明 `>=0.2.1-rc.2 <0.3.0-0`。
