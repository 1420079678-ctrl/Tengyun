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

- `app.asar` 重新打包为 10 个文件，sha256 `39a278b9…`（旧版为 `3792013e…`）。
- `Tengyun.exe` 正常启动并显示窗口，加载真实历史任务。
- renderer 保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，IPC 仍按窗口 + 主框架 + URL 逐字校验。
- 旧版 `app.asar` 已备份至 `D:\Tengyun\backups\baseline-0.1.0\app.asar`，可随时回滚。

## 已知问题与环境约束

- 从一个 Electron 应用（本会话所在的 DeepSeek Harness）里启动 `Tengyun.exe` 会立即退出，原因是子进程继承了 `ELECTRON_RUN_AS_NODE`，让 Electron 退化成纯 Node 模式。从资源管理器双击不受影响。需要从其他应用拉起时请先清除该环境变量。
- 桌面 OCR 观测通道在本机会间歇失败，因此界面验证改用 Win32 `PrintWindow` 直接抓窗口（`tools\shot.ps1`），并做了 DPI 感知处理。

## 未验证或尚未实现

- **模型接口的真实推理与工具调用效果未做付费验证**：端到端用的是本地桩。流式解析按 OpenAI SSE 规范实现，并对"网关返回 JSON 而非 SSE"和"网关拒绝 stream"做了降级，但未在真实厂商接口上跑过。
- 没有运行 SWE-bench 或其他可比较基准，不宣称超越现有 Agent。
- 工具调用在一个任务内仍顺序执行；并行子任务、跨任务调度、MCP 尚未实现。
- `approval: never` 模式会跳过写入与命令确认，默认模式仍是每次确认。
- 旧项目插件能力尚未移植进本内核（移植工作进行中，完成后另行记录）。

安装目录：`D:\Tengyun`。独立源码仓库：`D:\TengyunSource`。构建产物与验证脚本：`D:\Tengyun\tools`。源码修改后需重新打包 `app.asar` 才能反映到已安装的程序。
