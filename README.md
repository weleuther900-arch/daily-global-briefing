# Daily Global Briefing

[![Daily Global Briefing](https://github.com/weleuther900-arch/daily-global-briefing/actions/workflows/daily-briefing.yml/badge.svg)](https://github.com/weleuther900-arch/daily-global-briefing/actions/workflows/daily-briefing.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一套可自托管的中文全球晨报系统。它从可审计的公开来源中发现候选信息，完成来源、时间、访问状态、重复和证据检查，再生成适合手机邮件阅读的中文日报。

项目的重点不是堆积链接，而是把人工智能、数字经济、经济政策与全球商业环境中真正值得关注的变化，组织为一封可追溯、低噪声、有明确事实与分析边界的晨报。

<p align="center">
  <img src="design/email-visual-mockup-v1-iphone-dark-top.png" alt="全球晨报 iPhone 深色模式邮件预览" width="390">
</p>

## 适合谁

- 希望每天收到一封中文全球商业与科技晨报的个人用户。
- 希望以公开一手来源为核心、而非依赖单一新闻网站的人。
- 想部署可审计的信息筛选管道，并按自己的主题、来源和投递时间扩展它的开发者。

项目默认使用 GitHub Actions，无需保持个人电脑或服务器在线；你可以 Fork 后用自己的模型密钥、邮箱和来源配置独立运行。

## 覆盖什么

内容按五个编辑栏目组织：

| 栏目 | 关注的问题 |
| --- | --- |
| 人工智能 | 模型、产品、算力、芯片、企业应用、研究、安全与监管 |
| 数字经济 | 云与数据中心、半导体、平台、支付、网络安全、通信和企业软件 |
| 中国经济与政策 | 宏观数据、产业与贸易政策、监管、财政货币与数字基础设施 |
| 全球经济与政治 | 贸易、制裁、供应链、央行与宏观变化、影响企业经营的地缘政治 |
| 开源与技术生态 | GitHub 项目、发布记录、安全公告与具备实际技术价值的开发者动态 |

当前来源注册表包含 **50 个入口、8 个覆盖组**，横跨官方机构、监管部门、国际组织、央行、公司发布页、GitHub 以及权威媒体。系统优先用原始和官方材料支撑事实；媒体用于发现、交叉核对和补足背景。具体覆盖、筛选标准和已知盲区见 [来源与覆盖](docs/来源与覆盖.md)。

## 从来源到晨报

```text
公开来源 → 候选发现 → 覆盖审计 → 正文与访问状态提取
        → 主题路由、硬性排除、事件合并与历史去重
        → 结构化中文成稿 → 独立复核与规则校验
        → HTML / 纯文本 / MIME 邮件 → 可选投递
```

### 内置质量门禁

| 风险 | 对应机制 |
| --- | --- |
| 来源失效或覆盖不足 | 来源注册表、域名白名单与覆盖组下限检查 |
| 付费墙、无日期或误导页面 | 公开访问检测、发布时间提取、重定向校验 |
| 重复或窗口外内容 | 固定 24 小时窗口、事件指纹、中文标题相似度与 14 日历史去重 |
| 不受支持的事实 | 关键事实绑定具体来源 URL，结构化生成后逐条独立复核 |
| 模型输出越界 | JSON 架构、链接白名单、确定性编辑校验与失败即停止 |
| 超预算或重复投递 | 月度成本门禁、运行锁、最小状态记录与发送幂等保护 |

自动发现不等于自动刊登。无法确认、依赖付费墙、与来源冲突，或与项目主题无关的候选会在进入邮件前被拒绝。

## 五分钟部署：Fork + GitHub Actions

推荐部署路径不需要服务器。

1. 在 GitHub 点击 **Fork**，创建自己的仓库副本。
2. 在你的仓库进入 `Settings → Secrets and variables → Actions`，添加下表中的必需 Secrets。
3. 进入 `Actions → Daily Global Briefing`，点击 **Enable workflow**。公开仓库 Fork 的定时工作流默认不会启用。
4. 先手动运行一次 `scan` 模式，确认来源连接正常；它不会调用模型或发送邮件。
5. 发送一次 `layout-test` 检查邮件版式后，将发送开关设为 `true`，之后工作流会按默认时间表自动运行。

| Secret | 是否必需 | 用途 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | 晨报成稿与复核 |
| `GMAIL_APP_PASSWORD` | 是 | Gmail SMTP 应用密码 |
| `BRIEFING_SENDER_ADDRESS` | 是 | 发件邮箱 |
| `BRIEFING_RECIPIENT_ADDRESS` | 是 | 收件邮箱；可与发件邮箱相同 |
| `ENABLE_EMAIL_SEND` | 是 | 初始填 `false`，完成测试后改为 `true` |
| `X_BEARER_TOKEN` | 否 | 读取限定官方 X 帐号的公开原帖；未配置会自动跳过 |

完整的逐步操作、首次测试、时间表和故障排查见 [部署指南](docs/部署指南.md)。GitHub Actions 定时任务必须位于默认分支；公开仓库连续 60 天没有活动时，GitHub 也可能自动停用定时工作流，重新启用即可。

## 本地快速开始

运行环境：Node.js 20 或更高版本。本项目当前没有第三方运行时依赖。

```powershell
git clone https://github.com/weleuther900-arch/daily-global-briefing.git
cd daily-global-briefing
npm test
npm run build:sample
```

样例数据只用于验证流程，不代表真实新闻。构建后的 `output/` 目录包含：

- `briefing-YYYY-MM-DD.html`：移动端优先的邮件 HTML
- `briefing-YYYY-MM-DD.txt`：同封邮件的纯文本备用正文
- `briefing-YYYY-MM-DD.audit.json`：候选拒绝、合并和校验摘要
- `briefing-YYYY-MM-DD.selected.json`：最终入选事件的最小审计数据
- `briefing-YYYY-MM-DD.eml`：标准 MIME 邮件文件

### 常用命令

```powershell
# 运行完整自动化测试
npm test

# 使用固定样例构建晨报（不联网、不调用模型、不发信）
npm run build:sample
npm run run:sample

# 分步执行来源发现、正文提取和候选准备
npm run discover
npm run details
npm run candidates -- --date 2026-08-17
```

## 自定义方式

- 在 [config/sources.v1.json](config/sources.v1.json) 中添加或关闭来源，并将来源加入合适的覆盖组。
- 在 [src/config.cjs](src/config.cjs) 中调整栏目、窗口、去重保留期和硬性排除项。
- 在 [src/render.cjs](src/render.cjs) 中修改邮件结构与视觉样式。
- 在 [`.github/workflows/daily-briefing.yml`](.github/workflows/daily-briefing.yml) 中调整定时任务、模型和预算。

配置来源时应保留 HTTPS 域名白名单和公开访问要求；不要把密钥、个人邮箱或内部运行记录写入仓库。

## 安全与隐私

- 只处理已登记、公开可访问的来源；网页中的任何指令都被当作不可信数据。
- 个人投递地址、密钥和内部资料只应放在 GitHub Secrets 或本地忽略目录，不进入 Git。
- 邮件投递必须同时满足运行参数与环境开关；缺少任一条件时只生成本地产物，不连接邮件服务。
- 项目不读取收件箱、联系人、附件或邮件回复。

安全问题请遵循 [安全政策](SECURITY.md)，不要将密钥、访问令牌或可利用细节发布到公开 Issue。

## 仓库结构

```text
.github/workflows/  GitHub Actions 调度与运行配置
config/             来源注册表与覆盖组
src/                发现、抽取、路由、生成、校验、渲染和运行时核心
scripts/            本地命令入口与预览工具
tests/              Node.js 自动化测试
examples/           不含真实新闻的流程样例
design/             邮件视觉稿与渲染素材
docs/               公开项目、覆盖与部署说明
.private/           仅本地保留的配置和记录（被 Git 忽略）
```

## 参与贡献

欢迎改进来源稳定性、内容筛选、邮件体验、测试和文档。提交前请阅读 [贡献指南](CONTRIBUTING.md)，运行 `npm test`，并确保不提交任何密钥、真实邮件地址或抓取缓存。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。`package.json` 中的 `private: true` 只用于防止意外发布到 npm，不影响 GitHub 上的开源、Fork、使用或二次开发。
