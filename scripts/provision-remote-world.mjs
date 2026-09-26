#!/usr/bin/env node
/**
 * provision-remote-world.mjs — 把一台「只有 sshd」的远端主机升级成可承载
 * dsh-ssh 执行世界的主机，并吐出对应的 profile overlay。
 *
 * 背景（B-β 方案 §5.5）：`dsh-ssh` 用 `BatchMode=yes` 调 ssh，密码认证在客户端
 * 就被剔除，且它只接受 OpenSSH 别名。所以引导与运行必须分两条通道：
 *
 *   引导（本脚本，一次性）  用普通 ssh，公钥登录，装 Node / helper / 依赖
 *   运行（dsh-ssh）        别名 + 公钥 + BatchMode，提供远端 fs/subprocess/sandbox
 *
 * 脚本幂等：已就绪的步骤会跳过；重复执行只做校验。
 *
 * 用法：
 *   node scripts/provision-remote-world.mjs --ssh dsh-wsl2
 *   node scripts/provision-remote-world.mjs --ssh dsh-wsl2 --out /tmp/overlay.yml
 *
 * 前置：`~/.ssh/config` 里已有可用别名，且该别名能用**公钥**免密登录
 *      （脚本会以 BatchMode 自检；失败时给出补公钥的提示）。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** dsh-ssh 及其 provider 的版本线；须与 KCoder 基线的 @deepseek-ai/* 同线。 */
const SSH_PACKAGE_VERSION = '0.1.7-rc.2'
/** helper 的**直接**依赖。dsh-ssh 的 peer 在 npm 上已改写为真实版本，可解析。 */
const HELPER_PACKAGES = [
  '@deepseek-ai/dsh-ssh',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-session-projection',
]
/** cordis 独立版本线（dsh-ssh 的 peer 是 ~4.0.4）。 */
const CORDIS_VERSION = '4.0.4'

function parseArgs(argv) {
  const out = { ssh: undefined, root: '$HOME/.dsh-remote', workspace: '$HOME/dsh-ws', nodeVersion: 'v24.21.0', out: undefined, register: false, hostId: undefined, name: undefined }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--ssh': out.ssh = value; i++; break
      case '--root': out.root = value; i++; break
      case '--workspace': out.workspace = value; i++; break
      case '--node-version': out.nodeVersion = value; i++; break
      case '--out': out.out = value; i++; break
      case '--register': out.register = true; break
      case '--host-id': out.hostId = value; i++; break
      case '--name': out.name = value; i++; break
      case '--help': case '-h': out.help = true; break
      default: throw new Error(`未知参数：${key}`)
    }
  }
  return out
}

const USAGE = `用法：node scripts/provision-remote-world.mjs --ssh <别名> [选项]

  --ssh <别名>          ~/.ssh/config 里的 Host 别名（必填）
  --root <远端路径>     Node 与 helper 的安装根（默认 $HOME/.dsh-remote）
  --workspace <远端路径> 远端默认工作区（默认 $HOME/dsh-ws）
  --node-version <v>    远端 Node 版本（默认 v24.21.0，需 >=22.19 或 >=24）
  --out <文件>          overlay YAML 输出路径（缺省打印到 stdout）
  --register            把世界描述写入 <DSH_HOME>/ssh-remote/worlds.json，
                        供 KCoder「远程」菜单起逐主机 sidecar
  --host-id <id>        注册用的主机 id（默认取别名）
  --name <名称>         注册用的展示名（默认取别名）`

/** 在远端执行一段 bash（脚本经 stdin 传入，避免引号地狱）。 */
function remote(sshAlias, script) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', sshAlias, 'bash -s'], {
    input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** 在远端执行并原样回显（供人看进度）。 */
function remotePassthrough(sshAlias, script) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', sshAlias, 'bash -s'], {
    input: script, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'],
  })
}

function preflight(alias) {
  try {
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', alias, 'true'], { stdio: 'pipe' })
  } catch (error) {
    throw new Error(
      `别名 "${alias}" 无法用公钥免密登录（dsh-ssh 用 BatchMode=yes，密码认证会被 OpenSSH 在客户端剔除）。\n`
      + '先补公钥与别名：\n'
      + `  ssh-keygen -t ed25519 -N '' -f ~/.ssh/${alias}_ed25519\n`
      + `  ssh-copy-id -i ~/.ssh/${alias}_ed25519.pub <user>@<host>\n`
      + `  # 然后在 ~/.ssh/config 写一个 Host ${alias}（HostName/Port/User/IdentityFile/IdentitiesOnly yes）\n`
      + `原始错误：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function emitOverlay({ alias, node, helper, helperHash, workspace }) {
  return `# 由 provision-remote-world.mjs 生成——远端 SSH 执行世界（dsh-ssh）
# 用法：DSH_HOME=~/.kcoder-dev dsh <profile> --patch <本文件>

# 1) 执行世界：禁用本地 provider，腾出 ctx.subprocess / ctx.sandbox / ctx.fs
- id: subprocess
  name: "@deepseek-ai/dsh-subprocess-local"
  disabled: true
- id: sandbox
  name: "@deepseek-ai/dsh-sandbox-local"
  disabled: true
- id: fs-sandbox
  name: "@deepseek-ai/dsh-fs-sandbox"
  disabled: true
- id: sandbox-policy
  name: "@deepseek-ai/dsh-sandbox-policy"
  config:
    mode: workspace-write
    workspaceRoot: ${workspace}

# 2) 目录选择器：钉成应用内 browse（macOS 的 auto 会选 native OS 对话框）
- id: directory-picker
  name: "@deepseek-ai/dsh-host-directory-picker-auto"
  disabled: true

# 3) 插入 SSH 世界
- insert:
    - id: ssh
      name: "@deepseek-ai/dsh-ssh"
      config:
        host: ${alias}
        node: ${node}
        helper: ${helper}
        helperHash: ${helperHash}
        workspace: ${workspace}
    - id: subprocess-ssh
      name: "@deepseek-ai/dsh-subprocess-ssh"
    - id: sandbox-ssh
      name: "@deepseek-ai/dsh-sandbox-ssh"
    - id: fs-ssh
      name: "@deepseek-ai/dsh-fs-ssh"
    - id: directory-picker-browse
      name: "@deepseek-ai/dsh-host-directory-picker-browse"
    - id: directory-picker-browse-surface
      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"
`
}

/**
 * 把世界描述 upsert 进 `<DSH_HOME>/ssh-remote/worlds.json`。
 *
 * 与插件主机注册表同目录同 home 口径（插件 harnessHome()：QILIN_HOME →
 * DSH_HOME → ~/.dsh；KCoder 侧 dshHome()：DSH_HOME → ~/.kcoder），
 * 但**分文件**：那份是主机与凭据，这份是「已引导就绪」的世界参数
 * （Node/helper/摘要/工作区）——前者可手填，后者只能由引导产出。
 * @param spec - 已引导就绪的世界描述。
 * @param home - DSH 家目录。
 */
function registerWorld(spec, home) {
  const dir = join(home, 'ssh-remote')
  const file = join(dir, 'worlds.json')
  mkdirSync(dir, { recursive: true })
  let worlds = []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(parsed)) worlds = parsed
  } catch {
    // 首次注册或缺损文件：从空表重建，覆盖式写入。
  }
  const next = worlds.filter((w) => w && w.hostId !== spec.hostId)
  next.push(spec)
  writeFileSync(file, `${JSON.stringify(next, undefined, 2)}\n`)
  return file
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) { console.log(USAGE); return }
  if (args.ssh === undefined) throw new Error(`缺少 --ssh\n\n${USAGE}`)

  console.log(`[1/5] 自检别名 "${args.ssh}" 的公钥登录…`)
  preflight(args.ssh)

  console.log('[2/5] 探测远端环境…')
  const facts = JSON.parse(remote(args.ssh, `
set -euo pipefail
printf '{"os":"%s","arch":"%s","home":"%s"}' "$(uname -s)" "$(uname -m)" "$HOME"
`).trim())
  if (facts.os !== 'Linux' && facts.os !== 'Darwin') {
    throw new Error(`远端必须是 Linux 或 macOS（测得 ${facts.os}）；上游 SSH provider 不支持其他平台`)
  }
  console.log(`      ${facts.os}/${facts.arch}  home=${facts.home}`)

  console.log('[3/5] 安装/校验远端 Node…')
  remotePassthrough(args.ssh, `
set -euo pipefail
ROOT="${args.root}"
VER="${args.nodeVersion}"
ARCH="$(uname -m)"; case "$ARCH" in x86_64) A=linux-x64 ;; aarch64|arm64) A=linux-arm64 ;; *) echo "不支持的架构 $ARCH" >&2; exit 1 ;; esac
TAR="node-$VER-$A.tar.xz"
if [ -x "$ROOT/node/bin/node" ]; then
  echo "      已存在：$("$ROOT/node/bin/node" -v)"
else
  mkdir -p "$ROOT"; cd "$ROOT"
  echo "      下载 $TAR（带官方 SHA-256 校验）"
  curl -fsSL -o "$TAR" "https://nodejs.org/dist/$VER/$TAR"
  curl -fsSL -o SHASUMS256.txt "https://nodejs.org/dist/$VER/SHASUMS256.txt"
  grep " $TAR\\$" SHASUMS256.txt | sha256sum -c -
  rm -rf "$ROOT/node"; mkdir -p "$ROOT/node"
  tar -xJf "$TAR" -C "$ROOT/node" --strip-components=1
  rm -f "$TAR"
  echo "      已安装：$("$ROOT/node/bin/node" -v)"
fi
`)

  console.log('[4/5] 安装/校验 helper 及其依赖…')
  remotePassthrough(args.ssh, `
set -euo pipefail
ROOT="${args.root}"
export PATH="$ROOT/node/bin:$PATH"
VER="${SSH_PACKAGE_VERSION}"
mkdir -p "$ROOT/helper"
cd "$ROOT/helper"
[ -f package.json ] || echo '{"name":"dsh-remote-helper","private":true,"version":"0.0.0"}' > package.json
SPECS=""
for p in ${HELPER_PACKAGES.join(' ')}; do SPECS="$SPECS $p@$VER"; done
npm i --no-audit --no-fund --loglevel=error $SPECS "@deepseek-ai/cordis@${CORDIS_VERSION}" >/dev/null
HELPER="$ROOT/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js"
[ -f "$HELPER" ] || { echo "helper 入口不存在：$HELPER" >&2; exit 1; }
OUT="$(node "$HELPER" </dev/null 2>&1 || true)"
case "$OUT" in
  *"Cannot find package"*|*ERR_MODULE_NOT_FOUND*) echo "依赖解析失败：$OUT" >&2; exit 1 ;;
esac
echo "      依赖解析 OK"
`)

  console.log('[5/5] 计算摘要并生成 overlay…')
  const result = JSON.parse(remote(args.ssh, `
set -euo pipefail
ROOT="${args.root}"
mkdir -p "${args.workspace}"
printf '{"node":"%s","helper":"%s","hash":"%s","workspace":"%s"}' \\
  "$ROOT/node/bin/node" \\
  "$ROOT/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js" \\
  "$(sha256sum "$ROOT/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js" | cut -d' ' -f1)" \\
  "${args.workspace}"
`).trim())

  const overlay = emitOverlay({
    alias: args.ssh, node: result.node, helper: result.helper, helperHash: result.hash, workspace: result.workspace,
  })
  if (args.out === undefined) {
    console.log('\n--- overlay ---')
    console.log(overlay)
  } else {
    writeFileSync(args.out, overlay)
    console.log(`\noverlay 已写入 ${args.out}`)
  }
  if (args.register === true) {
    const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.kcoder')
    const file = registerWorld({
      hostId: args.hostId ?? args.ssh,
      name: args.name ?? args.ssh,
      alias: args.ssh,
      node: result.node,
      helper: result.helper,
      helperHash: result.hash,
      workspace: result.workspace,
    }, home)
    console.log(`\n世界描述已注册：${file}`)
  }

  console.log(`\n完成。node=${result.node}\n      helper=${result.helper}\n      hash=${result.hash}\n      workspace=${result.workspace}`)
}

try {
  main()
} catch (error) {
  console.error(`\nprovision-remote-world 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
