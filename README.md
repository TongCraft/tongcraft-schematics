# TongCraft 投影素材库（测试中）

[![CI](https://img.shields.io/github/actions/workflow/status/TongCraft/tongcraft-schematics/ci.yml?branch=main&style=flat&label=CI&logo=githubactions)](https://github.com/TongCraft/tongcraft-schematics/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/TongCraft/tongcraft-schematics?style=flat&color=8AC6D1)](LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white)
![Litematica](https://img.shields.io/badge/format-.litematic-9C89B8?style=flat)

> 🚧 **测试中**：请保留投影原文件。功能和访问速度仍在验证，欢迎[反馈问题](https://github.com/TongCraft/tongcraft-schematics/issues)。

分享 Minecraft Litematica 投影文件：任何人都能浏览、下载；已加入 [TongCraft Sync](https://github.com/TongCraft/tongcraft-sync) 的受邀玩家可以上传，文件校验通过后立即公开。

**在线地址：** [library.weiuou.top](https://library.weiuou.top) · [sync.weiuou.top](https://sync.weiuou.top/health)（状态接口）· [下载 Sync 模组](https://github.com/TongCraft/tongcraft-sync/releases/latest)

## 如何使用

- **浏览与下载：** 打开[素材库](https://library.weiuou.top)直接浏览已保存的渲染图，点击详情后可下载、主动加载 3D 旋转与分层检查；也可以在 Sync 模组的多列卡片中浏览，进入详情下载或放置投影。
- **本地预览：** 点击「本地预览」选择 `.litematic`，文件仅在浏览器内读取。
- **上传：** 在游戏内连接同步地址 `https://sync.weiuou.top`，通过邀请加入后从模组领取网页登录链接。上传时自动生成并保存渲染图，后续访问直接加载图片。单个文件最多 16 MiB，每位成员每 24 小时最多上传 20 份。

网页和 API 运行在 Cloudflare Workers，目录存于 D1，投影文件存于 R2；GitHub 只保存代码并负责自动部署。

[部署与用量说明](docs/DEPLOYMENT.md) · [API 文档](docs/API.md) · [参与贡献](CONTRIBUTING.md) · [安全反馈](SECURITY.md)
