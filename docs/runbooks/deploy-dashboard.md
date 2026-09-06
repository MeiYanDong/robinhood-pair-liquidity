# PAIR 公开面板人工发布门禁

本项目不在 GitHub 保存服务器密钥，也不允许 CI 自动交易或自动发布。生产发布必须由
操作者人工发起，经本地门禁、阿里云控制面核验、一次性 SSH 凭据和公网读回后才
算完成。

## 发布前

1. 运行 `npm ci --ignore-scripts --no-audit --no-fund`。
2. 运行 `npm run check`，确认格式、lint、类型检查、测试和公开总账断言全部通过。
3. 如果此次变更包含新建、迁移或永久退出 LP，先在拥有完整本地执行记录的私有工作区
   运行 `npm run portfolio:build`，并确认 inventory 为 `verified_complete_at_safe_block`。
4. 使用 SWAS 控制面读回实例 ID、公网 IP、`Running` 状态与 Cloud Assistant 可用性。

## 发布

1. 创建带时间戳的发布包，不包含 `.env`、私钥、RPC URL、`node_modules`、执行中间态或未脱敏日志。
2. 通过 Cloud Assistant 临时安装一次性 SSH 公钥。
3. 上传发布包后运行 `dashboard/deploy/install-release.sh <release-dir>`。脚本会原子切换
   `current` 软链接，并等待 `/readyz` 成功。

## 发布后验证

1. 确认 systemd 与 Nginx 均为 `active` 且 `enabled`。
2. 检查公网 `/livez`、`/readyz`、`/api/portfolio` 和首页；`/readyz` 必须显示 `ready: true`。
3. 对比本地与公网 `dashboard/public/app.js` 的 SHA-256。
4. 核对变更涉及 NFT 的 owner、liquidity、区间、总账状态与安全区块。
5. 从服务器删除一次性 SSH 公钥，删除本地临时私钥，并以新连接被拒绝作为回读证据。

GitHub Actions 只是合并门禁，不是生产发布回执。没有完成上述公网验证时，只能说代码已通过
CI，不能说已部署。
