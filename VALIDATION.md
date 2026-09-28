# Tengyun 0.2.0 验证记录

日期：2026-09-27，Windows x64。

## 已通过

### 内核回归测试

`node --test D:\TengyunSource\kernel\system.test.mjs`：7 项全部通过。覆盖完整编码回路（真实写文件 + 真实 Node 检查 + 证据与备份落库）、用户拒绝后工作区保持为空、目录越界与 junction 逃逸拦截、审批缺失拦截、命令超时与退出码分离、取消落库、失败证据不可作为完成依据、凭据脱敏与事件尾部截断恢复。

### 端到端（本地模型桩 + 真实 Electron 应用 + CDP 驱动）

`node D:\Tengyun\tools\e2e-suite.mjs`：桩以 SSE 协议响应，真实应用在 `approval: always` 模式下跑完 7 轮模型调用、6 次工具调用、2 次审批弹窗，结果：

- 真实写入 `workspace\NOTES.md`（先读旧内容再改写，覆盖前已备份）
- 右侧变更面板渲染出真实 unified diff：5 行，+1 / -1
- 终态 `已完成`；计划中的三个任务因引用了真实 evidenceId 才被接受，引用伪造 id 时内核按设计拒绝
- token 统计：7 轮 · 1660 tok/轮 · 共 10780 tok
- 审批弹窗、工具摘要行、失败工具标红、流式消息气泡均按预期渲染

截图：`D:\Tengyun\verification\e2e-final.png`、`e2e-approval.png`、`e2e-running.png`。

### 打包与启动

- `app.asar` 重新打包为 15 个文件，sha256 `61a00a2d…`（0.1.0 为 `3792013e…`）。
- `Tengyun.exe` 正常启动并显示窗口，加载真实历史任务；界面为浅色主题。
- renderer 保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，IPC 仍按窗口 + 主框架 + URL 逐字校验。
- 旧版 `app.asar` 已备份至 `D:\Tengyun\backups\baseline-0.1.0\app.asar`，可随时回滚。

### 能力注册表（工具分发的可插拔层）

`node D:\Tengyun\tools\smoke-capabilities.mjs`：21 项检查全部通过。覆盖注册表暴露全部能力且无重名、`read_many` 批量读取并隔离单个文件的错误、`apply_patch` 的审批门禁/真实改写/diff/备份/非匹配拒绝/歧义拒绝/replaceAll、`git_diff` 在非仓库目录的明确失败、`git_commit` 的审批门禁、未知工具拒绝、`web_fetch` 拒绝非 HTTPS。

其中两条是修 bug 后才有意义的：`code.mjs` 最初把 `definitions` 导成了对象而非数组，注册表按约定跳过该模块，`read_many`/`apply_patch` 根本不存在；审批门禁最初只在能力分支执行，内置工具漏检——现有回归测试立刻抓到了后者。

### 界面外观

`node D:\Tengyun\tools\e2e-wallpaper.mjs`：三种外观均在真实应用中验证。壁纸模式下 `theme=wallpaper`、`has-wallpaper` 类存在、`--wallpaper-image` 与伪元素背景都解析为 `tengyun-wallpaper://`、侧栏 `backdrop-filter: blur(20px)`、主区背景 `rgba(255,255,255,0.58)`；切到浅色为 `rgb(255,255,255)`，切到深色为 `rgb(12,12,13)`。截图 `wallpaper.png`、`appearance-light.png`、`appearance-dark.png`。

壁纸最初走 data URL（1.5MB 图片 → 2.1MB base64），经 IPC 传入后在 CSSOM 静默丢弃——小值能设置成功、大值不生效，`style` 属性里始终为空。改为 `tengyun-wallpaper:` 自定义协议后，注入值只有几十字节。同时修掉一处自身引入的回归：重写界面时 CSP 的 `http-equiv` 被写成 `http`，等于整页策略失效。

## 已知问题与环境约束

- 从其他 Electron 应用里启动 `Tengyun.exe` 会立即退出，原因是子进程继承了 `ELECTRON_RUN_AS_NODE`，让 Electron 退化成纯 Node 模式。从资源管理器双击不受影响。需要从其他程序里拉起时，请先清除该环境变量。
- 桌面 OCR 观测通道在本机会间歇失败，因此界面验证改用 Win32 `PrintWindow` 直接抓窗口（`tools\shot.ps1`），并做了 DPI 感知处理。
- 老版本存下来的 `maxSteps: 12` 会继续生效（新代码的上限已放宽到 200），需要在设置里手动调高。

## 未验证或尚未实现

- **模型接口的真实推理与工具调用效果未做付费验证**：端到端用的是本地桩。流式解析按 OpenAI SSE 规范实现，并对"网关返回 JSON 而非 SSE"和"网关拒绝 stream"做了降级，但未在真实厂商接口上跑过。
- 没有运行 SWE-bench 或其他可比较基准，不宣称超越现有 Agent。
- 工具调用在一个任务内仍顺序执行；并行子任务、跨任务调度、MCP 尚未实现。
- `approval: never` 模式会跳过写入与命令确认，默认模式仍是每次确认。
- 扩展生态尚未提供：能力注册表已就位，现有能力模块为 code / git / web / office 四类。

安装目录：`D:\Tengyun`。独立源码仓库：`D:\TengyunSource`。构建产物与验证脚本：`D:\Tengyun\tools`。源码修改后需重新打包 `app.asar` 才能反映到已安装的程序。
