# Freeplane MCP

[English](README.md) | [简体中文](README.zh-CN.md)

本地优先的 MCP 服务器，让 AI 编程助手能够以结构化、修订安全的方式访问 Freeplane 思维导图。已通过 Apple Silicon macOS 上 Freeplane 1.13.3 的完整验证。

服务器通过 STDIO 通信，使用 MCP 协议修订版 2025-11-25。它通过令牌认证的本地桥接连接到运行中的 Freeplane 实例，离线时可回退到基于文件的只读访问。写入操作具有修订守卫和回读验证；导图编辑可作为单个复合单元撤销。无遥测、无公共监听，运行时唯一的网络连接是本地桥接。

## 功能概览

- 读取实时导图树，支持分页、子树作用域、节点选区和字面量搜索
- 提交原子化多操作编辑，具有复合撤销、失败回滚和幂等键
- 组织导图：克隆、摘要、样式、布局、云形、书签、公式、提醒
- 管理文档生命周期：创建、打开、保存、另存为、关闭、还原，含确认守卫
- 导出导图为 PNG、PDF、SVG 或 HTML，经过结构验证和原子化文件放置
- 通过白名单 macOS 辅助功能助手控制演示导航和打印预览开关
- 基于游标轮询的实时变更日志监听
- Freeplane 未运行时回退到直接 XML 文件读取
- 对已关闭的 `.mm` 文件写入节点文本，带备份保留和字节级完整性校验

## MCP 工具

v1.0 稳定版精确暴露十二个工具：

| 工具 | 说明 |
|------|------|
| `freeplane_status` | 桥接连接状态、活动导图、降级状态和恢复状况 |
| `freeplane_capabilities` | 来自本地验证报告的冻结能力清单 |
| `freeplane_list_maps` | 通过桥接列出已打开导图，离线时列出已配置的保存导图 |
| `freeplane_read` | 分页导图快照，支持作用域、深度、字段投影和选区 |
| `freeplane_search` | 在节点树上执行有界的字面量文本搜索 |
| `freeplane_changes` | 基于游标的实时事件日志，支持可选长轮询 |
| `freeplane_view` | 对活动导图视图应用或清除字面量文本过滤器 |
| `freeplane_apply` | 带修订守卫、回读验证和确认机制的原子复合编辑 |
| `freeplane_history` | 单步撤销或重做，附带快照证据 |
| `freeplane_document` | 文档创建/打开/保存/另存为/关闭/还原生命周期 |
| `freeplane_export` | 整图导出为 PNG、PDF、SVG 或 HTML |
| `freeplane_invoke_action` | 演示导航和打印预览开关 |

## 架构

```
MCP 客户端 (Claude, Codex 等)
    │ STDIO (JSON-RPC)
    ▼
freeplane-mcp 服务器 (Node.js 22)
    │
    ├── 桥接客户端 ──► Freeplane Add-on (127.0.0.1, 临时端口, 令牌认证)
    │                     └── Freeplane 1.13.3 (宿主原生, 独立用户目录)
    ├── 文件回退 ────► 磁盘上的 .mm XML (只读或受限文本回写)
    └── AX 助手 ────► macOS 辅助功能 (仅演示/打印预览)
```

桥接仅绑定到 localhost 的操作系统分配端口。发现文件和令牌文件仅所有者可读。辅助功能助手受进程绑定、本地签名，且永远不会按下最终的“打印”按钮。

## 前置条件

- Apple Silicon macOS（唯一经过验证的平台）
- Freeplane 1.13.3（精确验证构建版本）
- Node.js 22.x，npm 10+
- Node 依赖和构建缓存需要 APFS 卷；源码本身可以位于 ExFAT，`npm run bootstrap` 会配置项目指定的本地缓存

## 安装（原生，推荐）

原生安装是首选方式，可获得全部十二个工具的完整能力，包括需要 macOS 辅助功能助手的 GUI 操作。

```bash
git clone https://github.com/Hilbert-beinghappy/freeplane-mcp.git
cd freeplane-mcp
npm run bootstrap
npm run install:local
npm run install:local -- --apply
```

第一次 `install:local` 预览安装计划，带 `--apply` 的第二次调用执行安装。安装器创建独立的 Freeplane 用户目录，不会修改全局脚本权限。

默认情况下，三个可执行文件会安装到 `~/Library/Application Support/Freeplane-MCP/install/bin/`：

- `freeplane-mcp` — STDIO MCP 服务器进程
- `freeplane-mcp-freeplane` — 启动带桥接 Add-on 的 Freeplane
- `freeplane-mcp-cli` — 管理命令行工具（`doctor`、`uninstall` 等）

### MCP 客户端配置

使用绝对路径将 MCP 客户端指向已安装的服务器。Claude Code `.mcp.json` 或其他 JSON 客户端示例：

```json
{
  "mcpServers": {
    "freeplane": {
      "command": "/Users/YOU/Library/Application Support/Freeplane-MCP/install/bin/freeplane-mcp",
      "args": []
    }
  }
}
```

Codex `config.toml` 示例：

```toml
[mcp_servers.freeplane]
command = "/Users/YOU/Library/Application Support/Freeplane-MCP/install/bin/freeplane-mcp"
args = []
```

请将 `/Users/YOU` 替换为你的 macOS 用户目录。如果自定义了 `FREEPLANE_MCP_HOME` 或 `--prefix`，请改用相应的安装前缀。

### 健康检查

通过专用启动器启动 Freeplane，然后检查安装状态：

```bash
FREEPLANE_MCP_INSTALL="$HOME/Library/Application Support/Freeplane-MCP/install"
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-freeplane" &
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-cli" doctor
```

`doctor` 命令验证桥接连接、Add-on 版本、辅助功能助手状态、验证报告存在性和文件回退配置。

### 卸载

卸载遵循相同的“先计划、后执行”模式：

```bash
FREEPLANE_MCP_INSTALL="$HOME/Library/Application Support/Freeplane-MCP/install"
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-cli" uninstall
"$FREEPLANE_MCP_INSTALL/bin/freeplane-mcp-cli" uninstall --apply
```

## 安装（Docker，可选）

Docker 方式仅在容器中运行 Node.js MCP 服务器进程。Freeplane、Java Add-on 和 macOS 辅助功能助手仍在宿主机上运行。本项目不发布预构建镜像，需要从源码本地构建。

这意味着通过 Docker 无法使用演示导航和打印预览控制——这些功能需要原生安装。

```bash
git clone https://github.com/Hilbert-beinghappy/freeplane-mcp.git
cd freeplane-mcp
docker build -t freeplane-mcp:1.0.0 .
```

请先完成原生安装（确保 Freeplane 和桥接 Add-on 已就绪），然后通过 STDIO 运行容器：

```bash
FREEPLANE_MCP_HOME="$HOME/Library/Application Support/Freeplane-MCP"
mkdir -p "$FREEPLANE_MCP_HOME/exports"

docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=${FREEPLANE_MCP_HOME}/runtime,dst=/runtime" \
  --mount "type=bind,src=${FREEPLANE_MCP_HOME}/exports,dst=${FREEPLANE_MCP_HOME}/exports" \
  -e FREEPLANE_MCP_RUNTIME_DIR=/runtime \
  -e FREEPLANE_MCP_BRIDGE_HOST=host.docker.internal \
  -e "FREEPLANE_MCP_ALLOWED_ROOTS=[\"${FREEPLANE_MCP_HOME}/exports\"]" \
  freeplane-mcp:1.0.0
```

宿主机 UID/GID 用于维持发现文件的所有权检查。桥接主机覆盖路由到 Docker Desktop 的本地网关。使用相同路径挂载导出目录，使容器和宿主机 Freeplane 都能验证导出产物。

## 开发与验证

```bash
npm run bootstrap          # 安装锁定依赖
npm run build              # 编译 TypeScript
npm test                   # 构建助手、编译、运行全部测试
npm run test:addon         # 构建并验证 Java 桥接 Add-on
npm run qualify:v1.0       # 运行完整的 v1.0 验证门
npm run doctor             # 检查本地安装健康状态
```

如果自动应用包发现不适用，请设置 `FREEPLANE_HOME` 或 `FREEPLANE_APP`。

历史版本验证门均可复现：

```bash
npm run qualify:v0.0a
npm run qualify:v0.0b
npm run qualify:v0.1
npm run qualify:v0.2
npm run qualify:v0.3
npm run qualify:v0.4
npm run qualify:v0.5
```

## 安全边界

以下功能被有意禁用，由 Schema 或能力策略强制拒绝：

- 原始 Freeplane 动作键、菜单路径或任意脚本
- Shell 命令、坐标输入或 URL 分发
- 公共网络监听或外部网络连接
- 遥测、上传或自动执行 Git/GitHub 操作
- 破坏性模态导入
- 节点或导图加密（无合格的安全输入通道）
- 最终打印提交（仅预览；助手永远不会按下“打印”）
- 含可执行表达式的条件样式
- 提醒脚本

破坏性操作（节点删除、文件覆盖、脏关闭、还原）需要绑定到计划、导图、桥接实例和修订版本的一次性确认。

未决或不确定的写入结果会阻断后续写入，直到执行显式回读对账。详见 [docs/recovery.md](docs/recovery.md)。

## 文档

- [v1.0 安装与发布边界](docs/v1.0.md)
- [兼容性说明](docs/compatibility.md)
- [恢复指南](docs/recovery.md)
- [安全策略](SECURITY.md)
- 验证证据：`qualification/reports/`
- 冻结能力表：`qualification/capabilities/capabilities.json`

## 许可证

Freeplane MCP 基于 [MIT License](LICENSE) 发布。运行时依赖（`@modelcontextprotocol/server`、`@modelcontextprotocol/core`、`zod`）同为 MIT 许可。

从本仓库构建的 Docker 镜像仅包含 Node.js MCP 服务器及其锁定依赖。Freeplane 是由用户另行安装的 GPL-2.0 软件。Java 桥接 Add-on 和 macOS 辅助功能助手不包含在容器镜像中。原生 macOS 产物已在本地完成验证，但尚未公证。

详情参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
