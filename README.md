# SimpleChat

SimpleChat 是一个基于 Cloudflare Pages + Workers + D1 + R2 构建的端到端加密 IM 骨架项目。前后端完全解耦，前端当前以 Web 形式提供，但 API 与密文协议独立，可继续扩展桌面端与移动端。

## 核心能力

- 浏览器本地完成消息加解密，Worker 永远只接收密文 envelope。
- 消息正文密文落 R2，D1 只保存索引与生命周期元数据。
- 支持消息到期焚烧，Worker 定时清理 D1 与 R2 中的过期数据。
- 使用长度分桶与随机填充降低流量特征暴露。
- 本地邮箱密码注册登录已内置，OAuth 骨架保留 Google / GitHub，可继续扩展更多身份源。
- Material Design 3 风格界面，布局参考 Gmail，多栏聊天体验。
- Markdown 消息渲染，默认启用 GFM 并进行白名单清洗。
- 为避免超过 R2 免费额度，默认启用保守硬限制：8 KB 单条密文、128 MB 活跃密文总量、单用户 250 条/日。

## 重要安全说明

这个仓库实现的是“高安全架构基础版”，不是经过独立审计的 Signal 级产品。真正达到专业级安全软件标准，至少还需要：

- 第三方密码学审计与渗透测试
- 多设备密钥同步策略与设备撤销 UX
- 本地私钥二次包装（例如设备口令或硬件密钥）
- 更强的元数据隐藏、固定长度封包与 cover traffic
- 前端 CSP、SRI、依赖审计、供应链签名、可重复构建

因此，本项目当前适合作为高安全 IM 的工程起点，而不是直接宣称“已达到经过审计的专业级安全软件”。

## 架构

### Web (`apps/web`)

- React + Vite
- MUI Material 3 风格
- IndexedDB 保存设备密钥材料
- 本地 E2EE、Markdown 渲染、好友与会话界面

### API (`apps/api`)

- Cloudflare Worker + Hono
- 本地登录、OAuth 骨架、会话管理、好友管理、会话与消息 API
- Cron 定时清理过期消息
- D1 保存用户 / 设备 / 关系 / 消息索引
- R2 保存密文消息对象

### Shared (`packages/protocol`)

- 密文 envelope 类型
- TTL 选项、消息尺寸分桶、API 类型

## 本地开发

1. 安装依赖

```bash
npm install
```

2. 初始化 D1

```bash
npx wrangler d1 migrations apply simplechat-db --local --config apps/api/wrangler.jsonc
```

3. 启动 API

```bash
npm run dev:api
```

4. 启动前端

```bash
npm run dev:web
```

## Cloudflare 配置

需要在 Worker 中配置以下密钥 / 变量：

- `SESSION_SECRET`
- `APP_ORIGIN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_REDIRECT_URI`

并创建：

- 一个 D1 数据库
- 一个 R2 Bucket
- 一个 Worker
- 一个 Pages 项目（指向 `apps/web`）

## 部署建议

- 前端部署到 Cloudflare Pages
- API 部署到 Cloudflare Workers
- Pages 通过 `VITE_API_BASE_URL` 指向 Worker 域名
- 生产环境必须使用 HTTPS、自定义域、严格 CSP 与 `SameSite=None; Secure`
