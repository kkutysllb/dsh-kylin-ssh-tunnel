# 远程工作区：设计总结与 KCoder 侧接线方案

> 交接对象：KCoder（壳/工作区）侧开发。
> 插件侧（本仓库 `dsh-ssh-remote`）已实现的部分见 §2，接口承诺见 §5.5；需要
> KCoder 配合接线的部分见 §5，按阶段推进（§5.6）。
> 最后更新：2026-09-26，插件版本 v0.1.2+（提交 `675c1d9`）。

## 1. 需求与结论

**需求**：在"选择工作区"里选中**远程主机的目录**，让 agent 直接在该远端目录上完成任务。

**调研结论**（出处为 dsh 0.1.7-rc.2 源码）：

| 事实 | 出处 | 对本需求的含义 |
| --- | --- | --- |
| 工作区路径按**本地绝对路径**校验与使用 | `packages/api/workspace-controller/src/default-directory.ts`（`paths.isAbsolute`） | 远程路径**不能**直接当工作区，否则 bash/文件树/改动卡全部按本地 FS 解析而崩 |
| `ctx.directoryPicker` 是"选择工作区"的选目录缝隙，能力可判别：`native`（OS 对话框）/ `browse`（`list`/`createDirectory`，注释明写"供远程客户端使用，不在宿主屏渲染"） | `packages/host/directory-picker/src/index.ts` | 插件可提供**远程目录浏览后端**；能力并集可扩展，未知 `kind` 的默认行为是**隐藏选目录入口**而非报错 |
| 选目录的调用链：`client/ui-workspace/navigation.ts` → `api/workspace-controller/directory-picker.ts`（按 `capability().kind` 分发） | 同上两处 | 接线点明确：加一种来源 = 加一种 capability + 一段 UI |
| `systemPrompt.context()` 的 `text` 支持**函数**，每次组装提示时求值；空文本不贡献内容 | `packages/core/system-prompt/src/index.ts`（`PromptContext`） | "当前远程目标"可实时注入给 agent，无需重启会话 |
| 插件已有完整远程能力：`ssh_run/read/write/edit/glob/grep/push/pull`，`ssh_run` 支持 `cwd`，主机有 `defaultCwd` | 本插件 | agent 端零改造即可在远端干活 |

**结论：分两级**

- **A 级（插件内闭环，已实现）**：本地工作区**绑定**一个"远程目标"（主机 + 远端目录），
  agent 在远端目录干活、产物 `ssh_pull` 回本地工作区。壳无需任何改动。
- **B 级（需 KCoder 配合）**：把远程目录真正接进"选择工作区"——工作区标识 URI 化 +
  本地工具降级/适配 + 选目录对话框增加远程来源（§5）。

## 2. 已实现（插件侧）

### 2.1 架构

```
UI（设置页/胶囊） ─┐
                  ├─► loopback HTTP API ──► TargetStore（targets.json）
agent（ssh_target）┘         │                    │
                             ├─► browse（runner+ssh `pwd && ls -1Ap`）
                             └─► ssh_* 工具默认 cwd / systemPrompt.context() 实时注入
```

- **数据模型** `targets.json`：`{ bindings: { "<工作区路径>": { hostId, path, updatedAt } }, activeWorkspace }`
  —— 绑定**按工作区路径**存（多工作区互不干扰），`activeWorkspace` 指向最近使用的那个。
- **动态上下文**：`ctx.systemPrompt.context({ name:'ssh-remote-target', order:121, text: () => ... })`
  每次组装求值；无目标返回 `''`（零成本）。
- **默认 cwd**：`ssh_run` 未显式传 `cwd` 时，若所请求主机**就是目标主机**则落目标目录，
  否则仍走 `host.defaultCwd`（其它主机行为不变）。

### 2.2 接口清单（稳定面，KCoder 可直接对接）

| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| `GET` | `/ssh-remote/api/target` | — | `{ active, bindings }` |
| `PUT` | `/ssh-remote/api/target` | `{ workspace?, hostId, path }`（workspace 缺省落 `_default`） | `{ active, binding }` |
| `POST` | `/ssh-remote/api/target/unbind` | `{ workspace? }` | `{ removed, active }` |
| `POST` | `/ssh-remote/api/browse` | `{ hostId, path? }` | `{ path, parent, entries:[{name,isDir}] }`（`head -300` 截断） |
| `POST` | `/ssh-remote/api/probe` | `{ hostId }` | `{ ok, degraded, latencyMs, error }` |

错误码：`bad-request`（400）/ `not-found`（404，主机不存在）/ `directory-unreadable`（400）/
`conflict`（409）/ `bad-json`（400）。全部回环限定（非 127.0.0.1 → 403）。

### 2.3 工具（11 个）

`ssh_hosts` `ssh_status` `ssh_run` `ssh_read` `ssh_write` `ssh_edit` `ssh_glob` `ssh_grep`
`ssh_push` `ssh_pull` + **`ssh_target`**（`show`/`set`/`clear`：查/设/解绑当前远程目标）。

### 2.4 UI 入口

设置页主机卡片：「设为目标」按钮 + 「★ 当前目标」徽章（目标状态随主机列表拉取）。
会话头部胶囊：主机状态/连通性探测。远程逐层目录浏览走 `/api/browse`（供选目录器直接代理）。

## 3. 命令与验证

```bash
npm run typecheck   # node --check 全部源文件
npm test            # 247 断言 / 0 失败（T2–T20）
npm run setup-dev   # 链接 peer 依赖（开发）
```

dev 安装：`DSH_HOME=~/.kcoder-dev dsh --profile web add <repo>`（link: 安装）。
真机验证：设置页加主机 → 设密码 → 「测试连接」（1–2s 出结果）→ 新会话跑远程命令。
验证证据：T20（目标绑定 10 项）/ T19（建连失败快返回 + ControlPersist 语义）/
T17（凭据 API 不回显密码）/ T14（UI 渲染回归）。

## 4. 已知限制（诚实边界）

1. **并发多工作区**：映射本身按工作区隔离，但 `active` 指针是 last-writer-wins；两个工作区
   并发跑任务时，**未显式传 `cwd`** 的工具可能落到另一工作区的目标目录。规避：agent 按
   上下文显式传 `cwd`（上下文里有路径）；或阶段 1 接线后按会话隔离。
2. **键盘交互 2FA 不支持**（Google Authenticator 等）——无人值守无解，直接认证失败。
3. **文件树/终端/改动卡仍是本地**——远程文件要 `ssh_pull` 才可见（B 级解决）。
4. `workspace` 缺省落 `_default` ——等待 KCoder 传真实工作区路径（阶段 1）。
5. 密码加密库自管密钥：`credentials.key` 丢失 = 已存密码不可解（重设即可）。

## 5. KCoder 侧接线方案

### 5.1 总体思路

三级递进，每级独立可验收：

| 级别 | 目标 | KCoder 侧工作量 | 插件侧状态 |
| --- | --- | --- | --- |
| **L1** | 真实工作区路径接进绑定（会话/工作区切换时告知插件） | ~0.5 天 | 已就绪（API 支持 workspace 参数） |
| **L2** | 选工作区对话框里出现「远程主机…」来源 | 1–2 天 | 已就绪（`/api/browse` 可直接代理） |
| **L3** | 远程工作区真正远程操作（URI 化 + 本地工具降级/适配） | 3–5 天 | 能力齐备（ssh_* 全套） |

### 5.2 L1：真实工作区路径接线（最小改动，建议先做）

**现状**：插件无法感知会话的工作区，`PUT /api/target` 的 `workspace` 缺省落 `_default`。

**需要 KCoder**：在**工作区切换/会话创建**时把工作区绝对路径告知插件，两种等价做法任选：

1. （推荐）`workspace-controller` 增加一个工作区变更通知：会话创建/切换工作区后调用
   `PUT http://127.0.0.1:<port>/ssh-remote/api/target`，body
   `{ workspace: <绝对路径>, hostId, path }`；若仅切工作区不改目标，调用
   `POST /ssh-remote/api/target/unbind` 之外的轻量动作 —— 建议新增
   `POST /ssh-remote/api/target/activate { workspace }`（插件可按需补，语义=`setActive`）。
2. 或在 `ui-workspace` 拿到工作区后由客户端直接调上述 API（客户端已在插件内，可扩展）。

**验收**：切到工作区 X 后，`ssh_target`（`action:'show'`）返回 `active.workspace === X`；
agent 不传 `cwd` 的 `ssh_run` 落在 X 绑定的远端目录。

### 5.3 L2：选工作区对话框增加远程来源

**现有契约**（`packages/host/directory-picker/src/index.ts`）：

```ts
interface DirectoryPickerBrowseCapability {
  kind: 'browse'
  list(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  createDirectory(path: string, name: string): Promise<string>
}
```

**建议扩展**（利用"并集可扩展、未知 kind 默认隐藏入口"的既定语义）：

```ts
interface DirectoryPickerRemoteCapability {
  kind: 'remote'
  listHosts(signal?: AbortSignal): Promise<Array<{ id: string; name: string; host: string }>>
  list(hostId: string, path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  createDirectory(hostId: string, path: string, name: string): Promise<string>
}
```

**插件侧可直接代理**：`POST /ssh-remote/api/browse { hostId, path }` →
`{ path, parent, entries: [{ name, isDir }] }`，与 `DirectoryListing` 的形状一一对应
（KCoder 可做薄映射）；`listHosts` 对应 `GET /ssh-remote/api/hosts`。

**KCoder 侧工作量**：
1. `api/workspace-controller/directory-picker.ts`：按 `capability().kind === 'remote'` 分发
   新方法（现有分发器已按 kind 判别，加一个分支即可）。
2. `client/ui-workspace/navigation.ts`：选目录对话框加"来源"切换（本机 / 远程主机），
   远程来源 = 主机下拉 + 逐层列表 + 「选为工作区」。
3. **重要**：L2 选出的远程路径**必须**走 L3 的 URI 标识，否则会被 `default-directory.ts`
   的本地绝对路径校验拒掉 —— 所以 L2 的"选为工作区"按钮应产出
   `ssh://<hostId>/<abs-path>` 形式的标识，并由 L3 的工作区抽象承接。

### 5.4 L3：远程工作区真正远程操作（核心改造）

**关键**：工作区标识从"本地绝对路径"扩展为**工作区 URI**：

- `file:///abs/path`（现语义，保持不变）
- `ssh://<hostId>/<abs/path>`（新；hostId 引用插件里配置的主机）

**需要改的面（按包）**：

| 包 | 改什么 | 策略建议 |
| --- | --- | --- |
| `api/workspace-controller` | 工作区标识解析/校验接受 URI（`default-directory.ts` 的 `isAbsolute` 判定换成"本地绝对路径 **或** 合法 workspace URI"）；`default-workspace.ts` 的默认值逻辑保留本地语义 | 最小侵入：新增 `parseWorkspaceId()`，本地路径照旧 |
| 会话/agent 的 cwd | 远程工作区下本地工具的行为 | **策略 A（推荐，先做）**：本地工具显式降级——`bash` 在远程工作区返回"请用 `ssh_run`"，读写类同理；agent 由插件的 `ssh-remote-target` 上下文引导走 `ssh_*` |
| 同上 | 同上 | **策略 B（完整，后做）**：工具适配层——`bash→ssh_run`、`read/write/edit→ssh_read/write/edit`、`glob/grep→ssh_glob/grep` 透明代理；需 KCoder 提供"按工作区路由工具"的机制，或允许插件注册同名替换 |
| 文件树 / 改动卡 / deliverables | 远程目录的可见性 | 先隐藏或"仅本地镜像"；远程枚举用 `/ssh-remote/api/browse`，内容物化用 `ssh_pull` 到本地镜像目录 |
| 产物回流 | 远端产物落地本地 | 由 agent 调 `ssh_pull`（已有）；KCoder 可在 deliverables 收集时提示回流 |

**为什么策略 A 先做**：它把 agent 的行为约束在 `ssh_*`（已全部具备、已测试），不改本地
工具的实现；用户感知是"远程工作区下 agent 用 ssh 工具干活"，一天量级。策略 B 的透明代理
体验更好，但要动本地工具的执行通道，风险与工作量都大一个量级。

### 5.5 接口契约草案（可直接落地）

**插件承诺（稳定，不破坏）**：

1. HTTP：§2.2 五个端点 + 错误码；回环限定；响应不含密码/凭据。
2. `ssh_*` 工具语义：`cwd` 缺省时落到"目标目录（当主机匹配）"，否则 `host.defaultCwd`。
3. `ssh_target`：`show/set/clear`；`set` 校验主机存在后写绑定。
4. 系统提示上下文 `ssh-remote-target`：目标变更即时生效（函数式求值）。
5. 浏览语义：`browse` 列举目录一层（`ls -1Ap`，`head -300` 截断），`isDir` 已判定。

**希望 KCoder 暴露给插件（可选，便于 L1/L3）**：

1. 当前会话工作区（URI 或本地路径）的读取途径，或工作区变更事件（回调/轮询皆可）。
2. 工作区 URI 的解析/构造工具函数（避免插件侧各自实现字符串拼接）。

### 5.6 分阶段路线与验收

| 阶段 | 负责 | 内容 | 验收 |
| --- | --- | --- | --- |
| 0（已完成） | 插件 | 远程目标绑定 + `browse` API + `ssh_target` + 默认 cwd + 上下文注入 | `npm test` 247/0；真机密码登录探测 1–2s 返回 |
| 1 | KCoder | L1 真实工作区接线（§5.2） | 切工作区后 `ssh_target show` 的 `active.workspace` 正确；工具默认 cwd 正确 |
| 2 | KCoder | L2 选工作区对话框远程来源（§5.3） | 能从对话框逐层浏览远程目录并选中；产物为 `ssh://` 标识 |
| 3 | KCoder | L3 策略 A：工作区 URI 化 + 本地工具降级（§5.4） | 选 `ssh://` 工作区的会话里，`bash` 给出降级提示、`ssh_run` 正常；文件树显示本地镜像 |
| 4（可选） | KCoder+插件 | L3 策略 B：本地工具透明代理 | 同一会话内 `bash/read/glob` 在远程工作区下行为等价于本地 |

### 5.7 风险与边界

- **安全**：密码只在 AES-256-GCM 加密库（自管密钥），不进 `hosts.json`/日志/工具输出；
  远程命令参数一律 `shellQuote`（防注入）；`browse` 限 `head -300`（防大目录拖垮）。
- **2FA**：键盘交互 2FA 不支持，直接认证失败（有明确错误）。
- **并发**：§4.1 的 `active` 指针限制；阶段 1 后可按会话隔离。
- **网络**：建连失败快返回（master 退出即失败，实测 32s → 1–2s）；`ControlPersist`
  daemon 化语义已正确处理（exit 0 ≠ 失败，实测验证过）。

## 6. 附：运行时数据与配置

| 路径 | 内容 |
| --- | --- |
| `~/.kcoder-dev/ssh-remote/hosts.json` | 动态主机（**不含密码**） |
| `~/.kcoder-dev/ssh-remote/credentials.enc` | 密码凭据（AES-256-GCM，按 `user@host` 存） |
| `~/.kcoder-dev/ssh-remote/credentials.key` | 自管主密钥（32 字节，0600；可用 `credentialsKeyFile` 挪走） |
| `~/.kcoder-dev/ssh-remote/askpass.sh` | SSH_ASKPASS 助手（0700，自动重建） |
| `~/.kcoder-dev/ssh-remote/targets.json` | 远程目标绑定（本次新增） |
| `~/.kcoder-dev/ssh-remote/cm/` | ControlMaster 套接字 |

配置项（`ssh-remote.config`）：`hosts`（静态主机）、`hostsFile`、`credentialsFile`、
`credentialsKeyFile`、`commandTimeoutMs`。
