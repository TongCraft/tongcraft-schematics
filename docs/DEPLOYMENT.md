# 部署与运维

一个面向 TongCraft 玩家、可在网页和 [TongCraft Sync](https://github.com/TongCraft/tongcraft-sync) 模组中浏览的 `.litematic` 素材库。网页公开浏览和下载；已通过 Sync 邀请的成员可以上传，校验成功后立即公开。项目代码放在 GitHub，蓝图文件放在 Cloudflare R2，目录和网页会话放在 D1。

测试站点：[投影素材库](https://library.weiuou.top) · [同步服务状态](https://sync.weiuou.top/health)。

## 架构

```text
Minecraft 客户端 ── 正版会话证明 ──> TongCraft Sync 服务
       │                                  │
       └── 浏览、下载公开目录              └── 一次性网页登录票据
                   │                         │
网页 ──────────────┴────> Cloudflare Worker ─┼── D1：目录、会话
                                            └── R2：.litematic 文件
```

登录时，模组从 Sync 服务领取五分钟有效的一次性链接。浏览器把链接片段中的票据交给 Worker；Worker 向 Sync 服务兑换已验证的玩家身份，再发放一小时的 HttpOnly 网页会话。Sync 的完整编辑令牌和 Minecraft access token 不会进入网页。公共素材与共享投影是不同概念：下载素材不会自动在游戏服务器放置或发布投影。

## 本地开发

需要 Node.js 22 或更新版本；CI 使用 Node.js 24。

```sh
npm ci
npm run db:local
npm run dev
```

Wrangler 默认在本地模拟 D1 和 R2。公开浏览不需要 Sync 服务；要测试网页登录，可在忽略的 `.dev.vars` 中设置 `SYNC_API_URL=http://127.0.0.1:8787` 并运行带有素材库登录接口的 Sync 服务。

用自己的投影文件检查完整上传、预览和材料清单流程：

```sh
node scripts/local-preview.mjs "/path/to/example.litematic"
```

脚本只在 `.wrangler/` 中写入本地测试数据，并打印可在浏览器打开的本地地址。预览图是从投影自动生成的结构示意，采用近似颜色和采样后的俯视轮廓；材料 CSV 按方块 ID 统计，不自动换算合成配方。

```sh
npm run check
npm run test:e2e
npm audit --audit-level=high
```

蓝图限制：压缩文件最大 16 MiB，解压 NBT 最大 64 MiB、3200 万方块；每名成员每 24 小时最多上传 20 份。服务器端校验格式、结构和大小并计算 SHA-256；相同成员不能重复发布同一文件。所有上传都应是上传者有权公开的作品。

### R2 免费额度保护

素材库只使用 R2 Standard，并在 D1 中原子预留容量和操作次数：最多存储 **5 GB**，每天最多 **500 次写入**和 **10,000 次读取**。即使按连续 31 天计算，站内操作也至多为 15,500 次 A 类和 310,000 次 B 类，低于 R2 当前每月 100 万 / 1000 万次的免费额度。删除 R2 对象不计操作费；删除成功后才释放存储容量。管理员登录后可通过 `GET /api/usage` 查看站内计数。([R2 定价](https://developers.cloudflare.com/r2/pricing/))

这些限额只约束本项目经 Worker 发起的操作，不能限制同一 Cloudflare 账号内其他 R2 bucket、控制台或 API 的使用。应同时在 Cloudflare 控制台查看账号级 R2 用量与账单；本站不会主动突破自身限额。

## Cloudflare 部署

1. 登录 Cloudflare，并确认 `weiuou.top` 是已激活的 zone：`npx wrangler login`。
2. 创建资源：`npx wrangler r2 bucket create tongcraft-schematics`、`npx wrangler d1 create tongcraft-schematics`；记下 D1 数据库 UUID 和 Cloudflare Account ID。
3. 部署 [TongCraft Sync](https://github.com/TongCraft/tongcraft-sync) 的素材库票据接口，确认它有公网 HTTPS 地址，并把该地址设置为 `SYNC_API_URL`。
4. 设置 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`SYNC_API_URL` 环境变量，执行 `node scripts/prepare-deploy.mjs`，然后运行 `npx wrangler d1 migrations apply tongcraft-schematics --remote --config .wrangler/deploy.json` 和 `npx wrangler deploy --config .wrangler/deploy.json`。
5. 检查 `https://library.weiuou.top/api/health`、网页浏览、模组登录、上传与下载。

如果 Sync 服务还没有公网 HTTPS 地址，可以临时设置 `ALLOW_PUBLIC_PREVIEW=true`、不设置 `SYNC_API_URL` 后生成部署配置。站点会公开显示浏览页，但登录和上传按钮暂不开放；接入 Sync 后重新部署即可启用。GitHub 自动部署也可通过仓库变量 `ALLOW_PUBLIC_PREVIEW=true` 发布只读预览；正式开放上传时设置 `SYNC_API_URL` 并把该变量改为 `false`。修改部署变量后可在 Actions 中手动运行 CI 工作流，或推送新提交，重新发布配置。

Cloudflare Worker 的 Custom Domain 会为 `library.weiuou.top` 创建相应 DNS 记录和证书；该名称不能已有冲突的 CNAME。生产配置文件在 `.wrangler/` 下生成，不提交账号和数据库标识。([Custom Domains 文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/))

### GitHub CI/CD

每次提交和 PR 运行类型检查、蓝图校验测试、Wrangler 打包检查和依赖审计。设置仓库变量 `DEPLOY_ENABLED=true`、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`，再设置 `SYNC_API_URL`（完整站点）或 `ALLOW_PUBLIC_PREVIEW=true`（只读预览），并设置仓库密钥 `CLOUDFLARE_API_TOKEN` 后，`main` 分支通过检查就会自动迁移 D1 并部署 Worker。请使用仅具备这些资源所需权限的 Cloudflare API Token。

### 中国大陆访问

这个部署使用 Cloudflare 全球网络，应从真实的大陆网络测试页面、API、上传和下载的可达性与速度。它不自动获得 Cloudflare 中国大陆节点；Cloudflare 中国网络是 Enterprise 计划的独立订阅，且要求域名备案。若实测链路不满足玩家需求，可保留相同 API 和仓库，改为国内或香港节点承载网页与文件分发。([Cloudflare 中国网络说明](https://developers.cloudflare.com/china-network/))

蓝图 NBT 结构校验基于 MIT 许可的 TongCraft Sync 校验逻辑扩展。公开接口见 [API 文档](API.md)。
