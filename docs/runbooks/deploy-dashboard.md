# PAIR 公开面板人工发布门禁

本项目不在 GitHub 保存服务器密钥，也不允许 CI 自动交易或自动发布。生产发布必须由
操作者人工发起，经本地门禁、阿里云控制面核验、一次性 SSH 凭据和公网读回后才
算完成。

## 发布前

1. 运行 `npm ci --ignore-scripts --no-audit --no-fund`。
2. 运行 `npm run check`，确认格式、lint、类型检查、测试和公开总账断言全部通过。
3. 如果此次变更包含新建、迁移或永久退出 LP，动态 inventory 会自动发现链上 NFT；如需
   精确资金来源和成本口径，仍应在拥有完整执行记录的私有工作区运行 `npm run portfolio:build`。
   发布前必须确认 `/api/inventory` 的 balance、索引持有数和逐仓验证数一致。
4. 使用 SWAS 控制面读回实例 ID、公网 IP、`Running` 状态与 Cloud Assistant 可用性。

## 发布

1. 创建带时间戳的发布包，根目录必须包含与 GitHub 主分支一致的 40 位 `GIT_COMMIT`；
   不包含 `.env`、私钥、RPC URL、`node_modules`、执行中间态或未脱敏日志。
2. 通过 Cloud Assistant 临时安装一次性 SSH 公钥。
3. 上传发布包后运行 `dashboard/deploy/install-release.sh <release-dir>`。脚本会原子切换
   `current` 软链接，并最多等待 150 秒让新进程自产一次成功快照、通过 `/readyz`。

## 发布后验证

1. 确认 systemd 与 Nginx 均为 `active` 且 `enabled`。
   同时确认当前 release 的 `GIT_COMMIT` 与已通过 CI 的主分支提交完全一致。
2. 检查公网 `/livez`、`/readyz`、`/api/inventory`、`/api/trend`、`/api/portfolio` 和首页；
   `/readyz` 必须显示 `ready: true`，inventory 必须为 `VERIFIED`，趋势模型必须保持
   `executionAuthorized=false`。
   新进程必须至少成功生成一次自己的安全区块快照，不能仅凭重启前留下的快照通过门禁。
   连续观察至少三个 60 秒刷新周期，确认安全区块持续前进且 journal 没有 RPC 失败循环。
3. 对比本地与公网 `dashboard/public/app.js` 的 SHA-256。
4. 核对变更涉及 NFT 的 owner、liquidity、区间、总账状态与安全区块。
5. 从服务器删除一次性 SSH 公钥，删除本地临时私钥，并以新连接被拒绝作为回读证据。

GitHub Actions 只是合并门禁，不是生产发布回执。没有完成上述公网验证时，只能说代码已通过
CI，不能说已部署。

## 回滚与 SQLite 恢复

应用回滚优先只切换 release，不覆盖数据库：先从备份记录读取上一 release 的绝对路径，确认
目录与 `GIT_COMMIT` 存在，再执行 `ln -sfn <上一 release 绝对路径>
/opt/pair-liquidity-dashboard/current` 和 `systemctl restart pair-liquidity-dashboard.service`，
随后重新完成全部发布后验证。不得使用模糊 glob 或未解析变量作为切换目标。

只有确认新 schema/写入损坏且应用回滚不足时才恢复 SQLite。停止服务后，先给现有数据库制作
第二份故障现场副本；对目标备份运行 `PRAGMA integrity_check`，再以明确的备份绝对路径替换
`/var/lib/pair-liquidity-dashboard/history.sqlite`，恢复 `pairdash:pairdash` 与 `0640` 权限，
启动服务并核对 inventory 游标、钱包余额和最新安全区块。数据库恢复会丢弃备份点之后的历史，
必须有明确故障证据和人工授权，不能作为常规应用回滚步骤。
