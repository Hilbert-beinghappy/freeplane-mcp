# Freeplane MCP

[English](README.md) | [简体中文](README.zh-CN.md)

面向 Apple Silicon macOS 上经过精确验证的 Freeplane 1.13.3，提供本地优先的 MCP 集成。

v1.0 本地稳定版提供 12 个目标级工具，覆盖实时读取、带修订号的变更、原子编辑与历史记录、知识组织、文档生命周期、经验证的导出、受限的已关闭文件文本回写，以及白名单内的演示和打印预览控制。不支持原始动作键、任意脚本或 Shell 命令、坐标操作、公共监听、上传、自动执行 Git/GitHub 操作、破坏性导入、加密和最终打印。

## 开发与验证

```bash
npm run bootstrap
npm test
npm run test:addon
npm run qualify:v1.0
```

如果无法使用应用包自动发现，请设置 `FREEPLANE_HOME` 或 `FREEPLANE_APP`。Node 依赖和构建缓存必须位于 APFS 卷上；当源码检出目录位于 ExFAT 卷时，`npm run bootstrap` 会配置本项目使用的本地缓存。

历史版本的验证门仍可通过 `npm run qualify:<version>` 复现，支持 `v0.0a`、`v0.0b`、`v0.1`、`v0.2`、`v0.3`、`v0.4` 和 `v0.5`。

## Docker 部署

本项目不发布预构建容器。请克隆仓库，并为当前平台在本地构建镜像：

```bash
git clone https://github.com/Hilbert-beinghappy/freeplane-mcp.git
cd freeplane-mcp
docker build -t freeplane-mcp:1.0.0 .
```

Freeplane 及其桥接 Add-on 仍在 macOS 宿主机上原生运行。请先完成[本机安装](#本机安装)，通过 `freeplane-mcp-freeplane` 启动 Freeplane，并保持 Docker Desktop 运行。随后使用拥有私有桥接发现文件的同一 macOS UID/GID 启动 STDIO 服务器：

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

MCP 客户端应通过持续保持的 STDIO 管道运行该命令。对于 Codex，请将下方的 `501:20` 和 `/Users/YOU` 替换为 `id -u`、`id -g` 的结果及你的主目录：

```toml
[mcp_servers.freeplane]
command = "docker"
args = [
  "run", "--rm", "-i",
  "--user", "501:20",
  "--mount", "type=bind,src=/Users/YOU/Library/Application Support/Freeplane-MCP/runtime,dst=/runtime",
  "--mount", "type=bind,src=/Users/YOU/Library/Application Support/Freeplane-MCP/exports,dst=/Users/YOU/Library/Application Support/Freeplane-MCP/exports",
  "-e", "FREEPLANE_MCP_RUNTIME_DIR=/runtime",
  "-e", "FREEPLANE_MCP_BRIDGE_HOST=host.docker.internal",
  "-e", "FREEPLANE_MCP_ALLOWED_ROOTS=[\"/Users/YOU/Library/Application Support/Freeplane-MCP/exports\"]",
  "freeplane-mcp:1.0.0"
]
```

使用相同路径挂载导出目录，可让容器和宿主机上的 Freeplane 共同验证导出文件。宿主机 UID/GID 用于维持发现文件的所有权检查；桥接主机覆盖仅接受 Docker Desktop 的本地网关。Linux 镜像不包含 Freeplane、Java Add-on 或 macOS 辅助功能助手，因此演示导航和打印预览控制只能通过原生 MCP 进程使用。

## 本机安装

请先安装 Freeplane 1.13.3 和 Node.js 22。然后克隆仓库、初始化锁定依赖、查看默认安装计划，并显式应用：

```bash
git clone https://github.com/Hilbert-beinghappy/freeplane-mcp.git
cd freeplane-mcp
npm run bootstrap
npm run install:local
npm run install:local -- --apply
```

安装器使用独立的 Freeplane 用户目录，不会更改整个配置文件范围内的脚本权限。请通过已安装的 `bin/freeplane-mcp-freeplane` 启动 Freeplane，将 Codex 配置为通过 STDIO 运行 `bin/freeplane-mcp`，并使用 `bin/freeplane-mcp-cli doctor` 检查安装状态。

卸载同样遵循“先计划、后执行”：

```bash
bin/freeplane-mcp-cli uninstall
bin/freeplane-mcp-cli uninstall --apply
```

另请参阅 [v1.0 安装与发布边界](docs/v1.0.md)、[兼容性说明](docs/compatibility.md)、[恢复指南](docs/recovery.md)和[安全策略](SECURITY.md)。验证证据位于 `qualification/reports/`，冻结的运行时能力表位于 `qualification/capabilities/capabilities.json`。

## 许可证状态

Freeplane MCP 基于 [MIT License](LICENSE) 发布。从本仓库构建的 Docker 镜像仅包含 Node MCP 进程及其锁定的 MIT 依赖；Freeplane 仍由用户另行安装并遵循 GPL-2.0。原生 macOS 产物已在本机完成验证，但尚未公证。详情参见[第三方声明与分发边界](THIRD_PARTY_NOTICES.md)。
