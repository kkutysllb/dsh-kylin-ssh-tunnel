# dsh-ssh-remote

DSH（DeepSeek Harness）插件：**SSH 远程运维/开发工具套件**——Agent 通过 10 个 `ssh_*` 工具在远程 Linux 主机上执行命令、读/写/编辑文件、搜索、双向传输（对标 VS Code Remote SSH 的核心工作流）。

- 系统 ssh 二进制 + **ControlMaster 连接复用**：首连后每次操作毫秒级；宿主重启自动重建；
- **远程文件编辑带防冲突**：读取记 sha256，提交前远端校验，文件被并发修改报 `stale-edit`；
- 所有命令/路径**参数数组直传**远端 shell，不经本地 shell——无引号地狱；
- 会话头部**状态胶囊**+面板；设置页**可视化主机管理**（表格 CRUD / 批量导入 / 导出，动态主机保存即生效）；
- 回环 HTTP API（非回环 403）。

## 安装

```bash
dsh plugin --profile web add git+https://github.com/<you>/dsh-kkutysllb-ssh-tunnel.git
```

静态主机（可选，重启生效）——profile `cordis.patch.yml`：

```yaml
- id: ssh-remote
  config:
    hosts:
      - id: prod-1
        name: 生产机 1
        host: 203.0.113.10
        user: root            # 默认 root
        port: 22              # 默认 22
        identityFile: ~/.ssh/id_ed25519
        jump: bastion         # 可选：跳板（引用另一主机 id → ssh -J）
        defaultCwd: /srv/app  # 可选
    commandTimeoutMs: 60000
```

动态主机：设置页「SSH 远程主机」区块添加/导入，写入 `~/.dsh/ssh-remote/hosts.json`，**热生效**。

## QiLin（麒麟）双通道适配（v0.1.1 起）

manifest 同时声明 `qilin` 与 `dsh` 两个通道的 `bundle.patch` / `client`：
QiLin（dsh 0.1.6-alpha.2 合并后）的插件管理器只认原生键
`qilin.bundle.patch`（缺失会报「没有声明组合包」），DSH 宿主仍读
`dsh.*`；两通道指向同一份 `cordis.patch.yml` 与 client 交付物，
行为完全一致。

## 麒麟（QiLin）引擎安装

```bash
# npm registry（推荐：版本可被插件管理检测，用户手动更新）
qilin plugin --profile qilin add dsh-ssh-remote

# GitHub 直装 / install straight from GitHub
qilin plugin --profile qilin add github:kkutysllb/dsh-kylin-ssh-tunnel
```

装完在 QiLin 设置 → 插件里可见、可启停；SSH 隧道/远程执行面板需要
系统 ssh（ControlMaster；Windows 降级直连）。

### 注意事项（QiLin）

- **必须经 `qilin plugin add` 装进 profile**：包会落到 profile 私有的
  `~/.qilin/profiles/<name>/node_modules`——裸包名原生解析的第一跳。
  **不要**手工把包目录放进共享的 `~/.qilin/profiles/node_modules`：
  dsh alpha.2 合并后的 runtime+enforce 解析把该目录划为安装保留区，
  放那里的 bundle 层包激活时直接 `failed to import`。
- **引擎版本**：运行需要带 dsh 兼容层的 QiLin 3.0.0+；插件**管理**
  （设置页展示/启停）要求 3.0.2+（alpha.2 合并后只认
  `qilin.bundle.patch` 原生键）。
- **运行时解析**：dsh alpha.2 起依赖解析默认运行时模式（PR #4471），
  插件运行期导入由 profile 安装图经进程内 generation 解析；引擎包按
  框架契约声明于 peerDependencies，由宿主安装副本统一解析。
- **数据根**（hosts.json、ControlMaster socket）按
  `QILIN_HOME → DSH_HOME → ~/.dsh` 解析（QiLin 启动器会把 DSH_HOME
  钉到麒麟家目录）。

## Agent 工具

| 工具 | 作用 |
|------|------|
| `ssh_hosts` | 列出主机（id/名称/来源/跳板）——远程任务先调它 |
| `ssh_status` | 连接池状态（master/延迟/命令数/最后错误） |
| `ssh_run` | 远程命令（bash 解释，cwd 可选，带超时）→ `{exitCode, stdout, stderr, durationMs}` |
| `ssh_read` | 读远程文件窗口（带行号，offset/limit；二进制拒绝） |
| `ssh_write` | 全量覆写（stdin→tmp→原子 mv；mkdirs 可选） |
| `ssh_edit` | 字面量替换（唯一命中或 replaceAll；**stale-edit 防冲突**） |
| `ssh_glob` | 远程 find -name（上限 200） |
| `ssh_grep` | 远程 grep -rnE -I（POSIX ERE；**-I 跳过二进制文件**；上限 250；默认排除 .git） |
| `ssh_push` / `ssh_pull` | 上传/下载（单文件 scp；目录 tar-over-ssh，recursive=true） |

## 设计要点

- **ControlMaster**：`~/.dsh/ssh-remote/cm/<id>.sock`，`ControlPersist` 默认 600s；操作前 `-O check`，失效自动重建；插件停止 `-O exit`。Windows 宿主自动降级逐次直连（功能完整，速度较慢）。
- **edit 防冲突**：读全文记 sha256 → 本地替换 → 远端「内容落 tmp → 原文件 sha 校验 → 原子 mv」，变了 exit 75 → `stale-edit`。
- **安全**：仅密钥认证（BatchMode）；`StrictHostKeyChecking=accept-new`（首连自动接受 host key，信任权衡自行评估）；HTTP API 仅回环。
- **已知限制**：
  - `ssh_run` 超时只终止本地 ssh，远端命令可能继续（可自行包 `timeout N cmd`）；
  - `ssh_grep` 为 POSIX ERE，与 ripgrep 语法有差异；
  - 编辑限 1MB 内文本；
  - `ssh_push` / `ssh_pull` 大目录（tar-over-ssh）默认 180s 超时，超大目录可通过 `timeoutMs` 参数放宽；
  - 非 22 端口主机的连接重建在下一次操作时自动完成（无操作内重试）；
  - scp 远端路径含特殊字符（空格/引号）时可能受限，复杂路径建议先 ssh_run 确认；
  - hostsFile（`~/.dsh/ssh-remote/hosts.json`）除设置页手工录入外，也支持在设置页从 `~/.ssh/config` 文本批量导入（解析 Host 块/ProxyJump，导入前可预览）；
  - HTTP API 状态码语义：404 = 路由不存在，409 = 冲突（静态主机不可删除/覆盖、id 重复、probe 目标不存在），403 = 非回环访问。

## 开发

```bash
npm run setup-dev   # node_modules → ~/.kcoder/profiles/node_modules 符号链接
npm run typecheck   # 8 文件 + client 语法检查
npm test            # 全量冒烟（fake spawn，不碰网络）
# 真机验证（可选）：
SSH_REMOTE_HOST=1.2.3.4 SSH_REMOTE_KEY=~/.ssh/id_ed25519 npm run live
```

## License

MIT
