# Changelog

## 0.1.3 (2026-09-27)

自 0.1.2 起累计（对齐 dsh 0.1.7-rc.2 世代后的首个功能版本）：

### 新增
- **密码登录**：`auth` 三态（`key`/`agent`/`password`）；密码存 AES-256-GCM 加密凭据库
  （自管密钥文件，`credentialsKeyFile` 可挪走），经 `SSH_ASKPASS` 助手喂给 ssh，
  不进命令行/环境变量/日志/工具输出。**私钥改为可选**——留空走 `~/.ssh/config` +
  ssh-agent + 默认密钥（修复"不填私钥的主机被静默丢弃"）。
- **远程目标绑定**：本地工作区 ↔ 远程目录绑定（`targets.json` 按工作区隔离），
  `ssh_run` 未传 `cwd` 自动落目标目录，系统提示实时注入当前目标；
  新工具 `ssh_target`（show/set/clear）；`POST /api/browse` 远程逐层目录列举。
- **设置页**：按 `dsh-coding-sidebar`「侧边卡片」的 DSH 原生配方重做（760px 内容列、
  group 卡片、计数徽章、主按钮反色填充、hover/focus/减弱动效）；每张主机卡片
  「测试连接」「设为目标」入口与「★ 当前目标」徽章。
- **远端执行世界引导**：`scripts/provision-remote-world.mjs`（含 `--register` 登记）+
  `POST /api/provision`；客户端目录来源切换（本机 / 远程主机）与应用内远程目录浏览。

### 修复
- 设置页白板：`useRef({})` 真值初值令默认状态永不建立，首帧 `undefined.map` 崩溃。
- 保存后列表为空：新增行 `id` 为空被当非法静默丢弃，服务端现自动补 id（slug + 去重），
  保存以服务端列表为准并透出 warnings。
- 密码编辑态「保存」按钮溢出到下一格被压住（跨 2 列 + 换行）。
- 探测失败慢（干等约 32s）→ master 退出即返回并透出 ssh 原文；正确处理
  `ControlPersist` daemon 化语义（前台 exit 0 = 成功，实测验证）。
- 空 stderr 时给出退出码而非含糊文案；补 `child.on('error')`（spawn 失败不再
  变成未捕获异常）。

### 文档
- `docs/remote-workspace-design.md`：远程工作区设计总结 + KCoder 侧接线方案
  （L1/L2/L3 分级、接口契约、验收标准、风险边界）。

验证：`npm run typecheck` ✓；`npm test` 247 断言 / 0 失败（T2–T20）。

## 0.1.2 (2026-09-26)

对齐 dsh 0.1.7-rc.2 世代契约：peer 范围（`>=0.1.0-rc.5 <0.2.0`）、`client.inject` 清理、
HTTP handler 收敛为 `(req, res)`、工具卡片呈现（presentCall/presentResult + presentationMeta）、
manifest 现代化（`manifestVersion: 1` + 本地化标题/图标）。
