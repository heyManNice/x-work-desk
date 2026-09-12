# tun-bundle —— 内置的 sing-box（Tun 代理服务端）

## 内容

| 文件 | 说明 |
|---|---|
| `sing-box-1.14.0-linux-amd64.tar.gz` | 官方发布包**原样内置**（未重打包） |
| `install-tun.sh` | 远端安装脚本，客户端经 SFTP 推送到 `/tmp` 后以 root 执行 |

## 来源与校验（provenance）

- 上游项目：`SagerNet/sing-box` — https://github.com/SagerNet/sing-box
- 版本：**v1.14.0**（2026-08-31 发布，stable；上一稳定线为 v1.13.21）
- 下载地址：`https://github.com/SagerNet/sing-box/releases/download/v1.14.0/sing-box-1.14.0-linux-amd64.tar.gz`
- sha256：`2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63`
  - 与 GitHub API 提供的 asset `digest` **完全一致**，可用 `sha256sum` 复核
- 许可证：**GPLv3**（包内自带 `LICENSE`）；客户端「关于」面板标注第三方组件

包内容（解开后）：`sing-box`（78MB）、`libcronet.so`（12MB，按需 dlopen，本项目的配置用不到）、`LICENSE`。

## 为什么内置而不是在线下载

1. **目标机常常没有公网**——而它正是需要代理的原因，让"装代理"这一步依赖访问 github 是最讽刺的失败方式；
2. **版本锁定**：配置由客户端生成，必须与 sing-box 版本成对回归，在线拉 latest 会随时破坏配置兼容；
3. **免供应链风险**：这是要以 root 运行的二进制，不接受"点一下就下载"；
4. **来源可验证**：原样内置官方包，文件哈希可与上游 digest 对照（自己重打包就丢了这个可验证链）。

代价是客户端安装包 +30MB（仓库 +30MB）。

## 升级方式

1. 替换本目录下的 tar.gz；
2. 同步更新 `electron/ssh/tun.cts` 里的 `SING_BOX_TGZ` 常量与本文档的版本/哈希；
3. 用 `sing-box check -c <客户端生成的配置>` 验证配置 schema 兼容（新版本若移除已弃用字段会在此暴露）。

## 变体说明

官方 amd64 包是**动态链接 glibc** 的（`libc/libdl/libpthread`）→ 适用于 Ubuntu/Debian（本项目的目标平台）。
若将来要支持 Alpine/musl 目标，需改用 `sing-box-<ver>-linux-amd64-musl.tar.gz`。

## 客户端生成的配置要点（`electron/ssh/tun.cts`）

- tun inbound：`172.19.0.1/30`、`auto_route`、`strict_route`、`stack: mixed`
- 上游：SOCKS5 或 HTTP 代理（无认证），来自面板的「服务器地址」
- 路由规则顺序：`sniff` → `hijack-dns` → 排除项（`ip_cidr` 用户列表 / `source_ip_cidr` 客户端 IP /
  `source_port` SSH 与远程桌面端口）→ `direct`，其余 `final: proxy`
  - **注意方向**：远端发出的回包目标端口是客户端的随机端口，所以"排除 SSH/桌面端口"必须写
    `source_port`（源端口）而不是 `port`（目标端口），否则挡不住"代理把自己连接断掉"。
