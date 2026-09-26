# dsh-ssh-remote 插件设计（v1）

> 日期：2026-09-18 · 状态：已与用户逐节确认
> 目标：为 DSH（DeepSeek Harness）提供「远程 SSH 运维/开发」能力——Agent 通过一套 `ssh_*` 工具在远程 Linux 服务器上执行命令、读/写/编辑文件、搜索、双向传输，体验对标 VS Code Remote SSH 的核心工作流（但不做透明工作区覆写）。

## 1. 背景与定位

- 参考项目 `GammaChineYov/dsh-ssh-tunnel`（v0.1.1，已通读源码并实测其 50 项冒烟测试全通过）证明了「spawn 参数数组直调系统 ssh + 测试注入」模式的可靠性，但其远程能力浅：只有 `ssh_run`/`ssh_push` 两个执行类工具，无文件编辑、无搜索、无设置界面，且进程管理 Windows 专用（`taskkill`/`netstat LISTENING` 正则）。
- 本项目在用户自己的仓库 `dsh-kkutysllb-ssh-tunnel` 中从零构建（空仓起步），定位为**通用远程运维/开发工具套件**，不做隧道管理（留 v2）。
- 平台假设：**宿主 macOS**（主力）/ 远程 **Linux 服务器**；Windows 宿主降级可用（见 §4.3）。
- 认证：仅密钥（`BatchMode=yes` 免交互），不支持密码。

## 2. 核心决策（已确认）

| 决策点 | 结论 |
|---|---|
| 交互形态 | Agent 工具套件（`ssh_*`），Agent 显式切换远程工具；**不覆写** `ctx.fs`/`ctx.shell`（透明工作区风险过高，明确排除） |
| v1 能力 | 远程命令执行 + 远程文件读/写/编辑 + 远程搜索（glob/grep）+ 双向文件传输 |
| 主机配置 | **全部在插件体系内声明**：静态（cordis.patch.yml）+ 动态（hostsFile，设置页写入、热重载）两路合并；运行时不读 `~/.ssh/config`（仅设置页可导入转换） |
| UI | ①会话头部状态胶囊+面板 ②设置页可视化配置区块（表格 CRUD、批量导入、导出） |
| 传输层 | **方案 A：系统 ssh 二进制 + ControlMaster 复用**（零依赖；否决 ssh2 库方案） |
| 验收场景 | ①远程运维排障（搜索定位→读配置→编辑修复→重启验证）②远程开发迭代（拉代码→改→传→跑测试） |

## 3. 模块结构

```
dsh-kkutysllb-ssh-tunnel/
├── package.json          # name: dsh-ssh-remote；peerDeps: cordis / dsh-tools / schemastery / react
├── cordis.patch.yml      # 插件注册（id: ssh-remote）
├── lib/
│   ├── index.js          # 宿主端 apply()：生命周期、10 个工具注册、系统提示、HTTP API
│   ├── hosts.js          # 主机注册表：静态+动态合并、字段校验/归一化、hostsFile 热重载（fs.watch）
│   ├── connection.js     # ControlMaster 管理器：惰性建连、ssh -O check 探活、残留 socket 清理、ssh -O exit 拆除、统计
│   ├── exec.js           # 远程命令执行核心：参数数组 spawn、stdout/stderr 限流截断、超时 kill
│   ├── fsops.js          # ssh_read/ssh_write/ssh_edit（sha256 防冲突关键段）/ssh_glob/ssh_grep
│   ├── transfer.js       # ssh_push/ssh_pull：单文件 scp、目录 tar-over-ssh
│   └── settings-store.js # hostsFile 原子写（tmp+rename）、导入解析（JSON/YAML/ssh_config 文本）
├── client/index.js       # 浏览器端：状态胶囊+面板、设置页配置区块（全行内样式，零全局副作用）
├── scripts/
│   ├── smoke-test.mjs    # fake spawn 注入测试（不碰网络）
│   └── live-test.mjs     # 真实主机端到端验证
└── docs/superpowers/specs/
```

## 4. 关键设计

### 4.1 主机模型与两路合并

```yaml
# profile cordis.patch.yml（静态，重启生效）
- id: ssh-remote
  config:
    hosts:                      # 静态主机（可空）
      - id: prod-1
        name: 生产机 1
        host: 1.2.3.4
        user: root
        port: 22
        identityFile: ~/.ssh/id_ed25519   # 支持 ~ 展开
        jump: bastion          # 可选：另一主机 id → ssh -J user@host:port
        defaultCwd: /srv/app   # 可选：ssh_run 无 cwd 时的缺省
        connectTimeoutSec: 15
        controlPersistSec: 600
    commandTimeoutMs: 60000     # ssh_run 缺省超时
    maxOutputBytes: 262144      # stdout 限流
    hostsFile: ~/.dsh/ssh-remote/hosts.json  # 动态主机（设置页维护）
```

- **合并规则**：动态与静态按 `id` 去重，**静态优先**（生产配置不可被设置页覆盖）；`hostsFile` 变更后注册表热重载（`fs.watch` + 防抖），工具与 UI 立即生效。
- **校验**：id 唯一且 `^[a-z0-9_-]+$`；jump 引用必须存在且禁止成环；port 1–65535；identityFile 存在性警告（不阻断）。

### 4.2 连接层（ControlMaster）

- 惰性建 master：`ssh -i <key> -p <port> -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=<n> -o ControlMaster=auto -o ControlPath=<cmDir>/<id>.sock -o ControlPersist=<sec> [-J u1@h1:p1] -N <user>@<host>`，socket 目录 `~/.dsh/ssh-remote/cm/`。
- 后续一切操作复用同一 `ControlPath`；操作前可 `ssh -O check` 快速探活。
- 复用 socket 失效（master 死亡）→ 删残留 socket 文件、重建一次后重试当前操作一次。
- 插件停止：逐主机 `ssh -O exit`；统计（延迟/命令数/最后错误/建连时间）供 `ssh_status` 与面板。
- **Windows 降级**：宿主为 win32 时不加 `ControlMaster/ControlPath/ControlPersist` 参数，逐次直连（功能完整，性能差，文档注明）。

### 4.3 执行与文件语义

- **ssh_run**：命令作为单个 argv 传给远端 shell；`cwd` 参数以 `cd '<cwd>' && ` 前缀实现（路径单引号转义）；返回 `{exitCode, stdout, stderr, durationMs, timedOut}`；超时 kill 本地进程并标记（远端进程可能残留，README 注明）。
- **ssh_read**：`sed -n '<a>,<b>p'`（offset/limit 起始行，1-based，默认 1–2000）；输出带行号、tab 分隔（对齐 DSH 本地 read 的呈现，降低 Agent 学习成本）；读前 8KB 探测 NUL 字节，命中即 `binary-rejected`。
- **ssh_write**：内容经 stdin 写远端临时文件后 `mv` 原子替换；`mkdirs` 选项控制是否建父目录；返回新 sha256。
- **ssh_edit（防冲突关键段）**：读远端文件 + 记录 sha256 → 本地执行字面量替换（默认唯一匹配，`replaceAll` 可选）→ 远端单条命令完成提交：`cat > <file>.tmp-<rand>; [ "$(sha256sum <file> | cut -d" " -f1)" = "<expected>" ] && mv <tmp> <file> || { rm -f <tmp>; exit 75; }`（内容走 stdin 先落 tmp，校验**原文件**未变才原子 mv；75 = stale 退出码）。语义对齐 DSH `FsVersion` 的乐观并发控制。
- **ssh_glob**：`find <root> -maxdepth <n> -name '<pattern>' -type f`，上限 200 条。
- **ssh_grep**：`grep -rnE [-i] -- '<pattern>' <path> [--include='<glob>'] --exclude-dir=.git`，上限 250 行；正则语法为 POSIX ERE（README 提示与本地 ripgrep 语法的差异）。
- **ssh_push / ssh_pull**：单文件 `scp [-P port]`；目录 `tar -C <srcDir> -cf - . | ssh <target> 'tar -C <dstDir> -xf -'`（推）与反向（拉）；远端目标目录不存在则先 `mkdir -p`。
- 所有远端路径/cwd 均过单引号转义函数（`'` → `'\''`）；命令与参数不经任何本地 shell。

### 4.4 Agent 工具清单（10 个）

`ssh_hosts`、`ssh_status`、`ssh_run`、`ssh_read`、`ssh_write`、`ssh_edit`、`ssh_glob`、`ssh_grep`、`ssh_push`、`ssh_pull`。

- `hostId` 一律可选，缺省取注册表第一台；未知 id 报错并列出可用 id。
- 系统提示注入（order ~121）：教 Agent「远程任务先 `ssh_hosts`，后续全用 ssh_* 工具；本地任务仍用本地工具」。

### 4.5 HTTP API（回环 only）

Host 头非 `127.0.0.1/localhost/[::1]` 一律 403（复用 dsh-ssh-tunnel 已验证的守卫）。

- `GET  /ssh-remote/api/status` — 连接池 + 主机状态视图
- `GET/POST/DELETE /ssh-remote/api/hosts[/:id]` — 设置页主机 CRUD（写 hostsFile）
- `POST /ssh-remote/api/hosts/import` — `{format: json|yaml|sshconfig, text}` → 解析预览/入库
- `POST /ssh-remote/api/probe` — `{hostId}` 连通性检查（`ssh -O check` + 轻量 exec 计时）

### 4.6 浏览器 UI

- **状态胶囊+面板**：注册 `conversation.session.header.utilities` 槽；聚合点（绿=全部可达 / 红=有不可达 / 灰=无主机）；浮窗每主机一行：状态点、名称、`user@host:port`、延迟、master 状态、操作（连通性检查、打开设置）；手动刷新，不轮询。
- **设置页区块**：主机表格 CRUD（字段同 §4.1）；批量导入（粘贴 JSON/YAML/`~/.ssh/config` 文本 → 解析预览 → 确认入库）；导出 JSON；所有写入走 `hostsFile` 原子写并热重载。
- 样式全 React 行内 + `--dsw-*` 主题变量 fallback（与 dsh-ssh-tunnel 同纪律：零全局副作用）。

### 4.7 错误处理

结构化失败分类（错误消息前缀化，Agent 可反应）：`unreachable`（网络/连接超时）、`auth`（公钥拒绝/Permission denied）、`stale-edit`（exit 75）、`not-found`、`binary-rejected`、`timed-out`、`spawn-error`。stderr 过滤 OpenSSH 良性噪音（post-quantum 提示等）。stdout/stderr 尾部截断限流 256KB/64KB。

## 5. 测试策略

- **smoke-test.mjs**（fake spawn/probe 注入，目标 ≥50 断言）：连接参数正确性（ControlMaster/-J/-p/scp -P）、socket 失效重建重试一次、ssh_run cwd 前缀与超时、read 行号与二进制拒绝、write 原子替换、edit 关键段（stale 必报 exit 75 → stale-edit）、glob/grep 参数与上限、10 工具注册与缺省 hostId、HTTP 403/200/404、hostsFile 合并去重（静态优先）与热重载、ssh_config 导入解析、Windows 降级参数（无 Control* 项）。
- **live-test.mjs**（用户提供一台真实 Linux 主机）：建连 → master 复用验证（第二条命令毫秒级）→ run/read/edit/push/pull 往返 → 模拟 master 死亡自动恢复。
- **验收场景（脚本化）**：
  1. 运维排障：`ssh_grep` 找报错关键字 → `ssh_read` 看配置段 → `ssh_edit` 修复 → `ssh_run` 重启服务并验证状态；
  2. 开发迭代：`ssh_pull` 拉远端代码 → 本地 `edit` 修改 → `ssh_push` 同步 → `ssh_run` 跑测试全绿。

## 6. v1 明确不做（范围外）

持久 pty shell（v2 候选）、端口转发/隧道管理（v2）、Windows 宿主完整支持（仅降级）、ssh2/SFTP 通道、密码/sudo 交互认证、多主机并发扇出（`ssh_run --all-hosts` 类）。

## 7. 风险与已弃方案记录

- **透明工作区（覆写 ctx.fs/ctx.shell）**：调研确认 DSH 有 fs/shell 抽象 seam，但覆写会波及附件、侧边栏、present、沙箱审批等本地链路，风险/收益比差，明确弃用。
- **ssh2 npm 库**：原生依赖安装风险 + 需自实现 host key/agent/跳板，收益（SFTP 精确语义）不抵成本，弃用。
- **ControlMaster 平台差异**：Windows OpenSSH 不支持 → 运行时探测 `process.platform` 降级；macOS/Linux 原生支持。
- **ssh_run 超时只杀本地 ssh**：远端命令可能继续跑（OpenSSH 命令行工具通病），README 注明；缓解：包装 `timeout <sec>` 可作为 v1.x 增强。
