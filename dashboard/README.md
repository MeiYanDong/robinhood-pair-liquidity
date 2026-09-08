# PAIR/SPY 公开实时面板

这是一个只读服务：它不加载钱包、不读取私钥、不签名，也没有交易入口。服务固定在
Robinhood Chain 的安全区块上读取 PAIR/SPY、PAIR/USDG 池、钱包全部历史 LP NFT 与现货余额，
并把增量 Swap 历史保存到 SQLite。网页每 5 秒拉取一次服务状态；服务默认每 60 秒追块，
快照落后链头 128 个块，以避开高出块频率下的节点同步抖动和短重组。

面板还以独立只读账户展示专用 PAIR/USDG 有限马丁钱包。该账户不借用旧钱包总账，而是从
配置的公开起始区块自动发现 PositionManager NFT，并在每个安全快照重新核验区间、本金与未领取
费用。公开服务不连接私有 Keeper 目录，因此链上状态可以是 `VERIFIED`，成本基础和 Keeper
运行健康仍分别标为 `UNKNOWN_NOT_IN_PUBLIC_LEDGER` 与 `NOT_OBSERVED_BY_DASHBOARD`。

面板同时读取 PAIR/USDG 1% 与 3% 两个候选池，以我们当前本金和四个美元价格区间做
同口径静态映射。对照不是照搬 Uniswap 全池 APR，而是把各池 Swap 按价格段归因到当前
流动性，并估算同一笔资金能捕获的费用。策略门槛固定为：6 小时和 24 小时窗口都完整、
都领先当前 SPY/PAIR 至少 30%，且 20% 试仓的保守增量费用可在 8 小时内覆盖模型迁移成本。
PAIR/USDG 池中已配置的真实 NFT 会另行按同一安全区块读取 owner、liquidity、本金与
feeGrowth；它们不会混入“同本金候选模拟仓”的比较口径。

## 数据口径

- `全生命周期总账`：先扫描 PositionManager 的钱包 Transfer 日志，再与本地运行账本做集合
  对账；已撤空 NFT 也保留。每笔本地交易按哈希去重并回查链上 receipt、状态、区块和 Gas。
- `当前本金`：仅为安全区块上仍有 liquidity 的 NFT 资产现值，不把已经领取并复投的手续费
  再次计作外部本金。
- `已记录手续费`：本地有明确 collect/迁移记录的历史费用，按当前市场价格重估；退出交易中
  未能从现有材料独立拆出的费用不反推、不补猜，因此它是有证据的下限而非完整税务账本。
- `vs 原币持有`：仅比较单个 NFT 的已知供给代币与该 NFT 当前本金加已记录手续费；发生迁移
  的仓位通过资金血缘连接，禁止把父子 NFT 的结果相加。
- `外部总投入`：只有来源明确的外部资金才能进入该口径。目前原生 ETH 转入和早期既有代币
  批次没有全部闭合，所以页面固定标为 `PARTIAL`，不会把钱包余额或复投费用冒充新增投入。
- `未领取手续费`：同一安全区块上的 NFT `feeGrowthInside` 读回，是钱包仓位口径。
- `成交量 / 全池费用`：Swap 路径按 200 Tick 分桶的市场估算，不等于钱包实际收入。
- `跨池对照`：候选池按各自 Tick spacing 重建当前流动性，再映射相同本金和美元区间；
  历史流量按当前流动性静态归因，不是历史实盘回测。
- `迁移成本`：公开 gas price、WETH/USDG 0.01% 只读报价、历史操作 gas 单元和路由缓冲的
  模型值；不是待签名交易的实时模拟，真正调仓仍必须另做 preflight。
- `SPY/USDG`：使用配置中的 Uniswap V3 0.05% 池，并在历史 Swap 发生时按事件顺序估值。
- `历史价格账本`：把每个 NFT 的入场市价、持仓期 PAIR/USDG 时间加权均价、当前/退出市价、
  LP 本金数量变化隐含的 PAIR 净买卖价，以及手续费调整后的局部结果分开显示。迁移或复投的
  子 NFT 不作为新的外部投入与父仓相加。
- `LP 净成交价`：只根据“进入 LP 的本金数量”与“当前或退出时本金数量”的净变化推导；能从
  退出回执拆出的手续费先剔除。它描述 LP 在区间内完成的净换币，不等于钱包现货买入均价。
- `持仓 TWAP`：由规范池 Swap 与 SPY/USDG 历史标价按事件顺序重建。历史锚点以前没有覆盖的
  时段固定标为 `PARTIAL`；缺少入场或退出资产证据时固定标为 `UNKNOWN`，不会用现价倒填。
- RPC 读取会短退避重试；持续失败时继续发布最后一份有效快照，并把状态明确标为
  `STALE`，不会伪装成实时。
- 新建、迁移或永久退出 LP 后，服务会增量读取 PositionManager `Transfer`，再以同一安全区块
  的 `balanceOf`、`ownerOf`、liquidity 和 pool info 做闭环核验；不再需要 Codex 手工更新面板。
- 自动发现但尚未进入审计账本的 NFT 会立即显示当前链上状态，但成本来源固定标为
  `UNKNOWN_EXTERNAL_ORIGIN`，直到公开账本补齐证据，避免把未知本金误算成手续费或零成本。
- `外部策略账户`：每个账户使用独立 SQLite inventory，避免与主钱包游标和历史成本互相污染；
  NFT 数量、归属、流动性、池和 Tick 均在同一安全区块核验。预期档位数不符只降级该策略，
  不把主钱包已有的可信快照误报为离线。

## 生命周期账本

联网重建并核验钱包全部 LP NFT、交易收据和本地运行记录：

```bash
npm run portfolio:build
```

RPC 暂时不可用、只需按上次链上审计结果重建展示层时：

```bash
npm run portfolio:build:offline
```

生成文件是 `config/lp-portfolio-ledger.json`。人工补录仅放在
`config/lp-portfolio-overrides.json`，必须带来源、交易哈希或明确的 `UNKNOWN` 边界；网页和
`/api/portfolio` 都只读取脱敏后的生成文件。不得把 RPC、私钥、Keychain 名称或签名材料放入
这两个文件。

## 本机运行

Node.js 22 或更高版本：

```bash
RH_RPC_URL='private-robinhood-rpc' npm run dashboard
```

并发的链上读取默认先在 `25ms` 内合并为最多 20 条 JSON-RPC 的批次，再为实际 HTTP
请求共享 `150ms` 的最小发起间隔，避免快照构建的并发读取击穿公共节点限流，同时
不把每个合约读取串行化。只有当专用 RPC 有明确的更高限额时，才应通过
`PAIR_DASHBOARD_RPC_MIN_INTERVAL_MS`、`PAIR_DASHBOARD_RPC_BATCH_SIZE` 和
`PAIR_DASHBOARD_RPC_BATCH_WAIT_MS` 调整这些值。

生产面板有自己的最小依赖清单 `dashboard/package.json`，只安装 `viem`。仓位本金使用与
Uniswap SDK 逐 wei 对照过的 TickMath 公式，服务器不安装交易执行器、Hardhat 或 Solc。

RPC URL 只能放在进程环境或权限为 `0600` 的环境文件里，不能提交到项目。验证：

```bash
npm run dashboard:check
curl http://127.0.0.1:8080/livez
curl http://127.0.0.1:8080/readyz
curl 'http://127.0.0.1:8080/api/snapshot?window=24h'
curl http://127.0.0.1:8080/api/inventory
curl http://127.0.0.1:8080/api/strategies
curl http://127.0.0.1:8080/api/trend
curl http://127.0.0.1:8080/api/portfolio
```

可选窗口为 `cycle|1h|6h|24h|7d`。在共同观察起点尚未覆盖完整 6h/24h 时，决策状态只能是
`BUILDING_EVIDENCE`，不会因为局部高年化提前升级为试仓建议。

## 服务器运行

生产环境使用 systemd 管理 Node 服务，Nginx 在公网 80 端口反向代理。RPC URL 位于
`/etc/pair-liquidity-dashboard.env`，文件内容为 `RH_RPC_URL=...`，权限必须是 `0600`。
SQLite 和最后有效快照位于 `/var/lib/pair-liquidity-dashboard`，发布目录只读。
除主 `history.sqlite` 外，`strategy-inventory-*.sqlite` 及其 WAL/SHM 文件也属于持久证据，备份时
必须在服务停止或 SQLite 一致性快照下整体保存。

部署后以三层证据验收：systemd 进程为 active、`/readyz` 为 LIVE、从公网 IP 读取的
`/api/snapshot` 含持续前进的安全区块。任何一层缺失，都不能称为“已经实时上线”。

当前生产实例、费用、入口与验收证据见 `../docs/pair-dashboard-production.md`。
