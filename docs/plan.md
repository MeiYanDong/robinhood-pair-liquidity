# PAIR Trend LP Keeper 与自动化面板需求方案

- 文档状态：需求基线，待按 `docs/todo.md` 实施
- 版本：1.0
- 日期：2026-09-08
- 私有实盘工作区：`/Users/myandong/Projects/LP`
- 公开 Git 仓库：`https://github.com/MeiYanDong/robinhood-pair-liquidity`
- 本地公开仓库克隆：`/Users/myandong/Projects/robinhood-pair-liquidity`
- 当前经济权限：只读 Shadow；本文不授权签名、广播、授权 Router、移动资金或部署执行器

## 1. 文档目的

本文把以下需求合并成一个可实施、可验收的产品与工程方案：

1. 修正当前趋势区间模型过窄的问题。模型曾给出 Tick `[106800, 108400]`，对应约 `$0.015143–$0.017771`；该区间只有约 `$0.002628` 的绝对宽度，在 PAIR 连续拉升时很容易被快速穿越。
2. 新模型不能继续用固定的 1,600/2,400/3,200 Tick 候选作为主要边界。趋势卖出主区间的目标绝对宽度应在 `$0.010000` 左右，而不是硬性规定“至少 `$0.010000`”。例如从 `$0.015143` 起，目标上限在 `$0.025` 左右；最终边界可以因 Tick 对齐、成交热区和波动率在目标附近上下调整，但不能重新退化成约 `$0.0026` 的窄区间。
3. `$0.01` 是模型的宽度中心值，不是价格加法器或硬下限。区间仍必须根据成交量热区、逐 Tick 市场流动性、我们的预期活跃份额、波动率、库存风险和换仓摩擦综合决定。
4. 模型的输入、候选区间、最终建议、评分理由、当前状态和数据可信度必须可视化到公开面板。
5. 面板必须由服务器自动发现钱包 NFT、自动读取链上状态、自动计算并自动刷新；不再依赖 Codex 手工重建 JSON、编辑仓位配置、生成静态 HTML 或手工上传数据。
6. 服务器正常状态下 7×24 小时运行；数据或回执状态不唯一时 fail closed。自动刷新不等于自动交易，交易权限仍需单独验收和授权。
7. Gas 不再用“8 小时手续费覆盖”或等待 `$0.5` 而不是 `$1` 的规则拖慢动作。当前 Shadow 策略只保留 `$25` 的异常熔断上限；滑点、市场深度、nonce、回执和数据一致性仍是独立门禁。
8. 对附件中的趋势型 LP 方案进行落地审计，明确哪些已经在本地实现、哪些在线上生效、哪些只是设计、哪些尚未验证。

本文是需求与架构基线，不是实盘授权书，也不把模拟结果表述为已执行交易或已实现收益。

## 2. 最终产品定义

产品名称暂定为 `PAIR Trend LP Keeper`。它不是普通的“把 LP 始终跟着现价平移”，而是一个分层系统：

- 趋势模型：识别 PAIR 上涨、区间临界、完整向上穿越、连续跳档和反转。
- 区间优化器：在 PAIR/USDG 价格空间先形成足够宽的候选，再结合成交热区与市场份额选区间。
- 组合感知：自动识别钱包当前和历史 NFT，知道哪些仓位在场内、场外、已撤、已转移或已烧毁。
- Shadow 决策层：持续给出 `HOLD`、`PREPARE`、`ROLL`、`EXIT` 或 `HALT` 建议，并保存证据，但不执行交易。
- 可视化控制台：在同一张价格图上展示市场、我们现有 LP、建议区间、下一档区间和策略状态。
- 未来执行层：只有在单独批准后，才按回执门禁执行撤仓、换币和重建仓位。

必须持续保持以下边界：

- 纯 LP 主仓、趋势型 LP Keeper 和 PAIR 现货网格是三个独立策略，不混用状态机、资金归因或执行权限。
- 公共面板永远不保存私钥，不签名，不向浏览器下发敏感配置。
- “页面会刷新”与“钱包仓位能自动发现”是两个不同能力，验收时必须分别证明。
- “模型推荐”与“链上已成交”是两个不同证据等级，面板必须显式标记。

## 3. 已确认的需求与默认解释

### 3.1 宽区间规则

用户给出的核心约束是“约 `$0.01` 的绝对价格宽度”，而不是固定 Tick 数，也不是“至少 `$0.01`”的单向硬约束：

```text
PAIR/USDG 目标绝对宽度中心值 = $0.010000
默认偏好带 = $0.008000–$0.012000（可配置、待历史回放校准）

示例：
候选价格下限 = $0.015143
目标价格上限 ≈ $0.025143
Tick 对齐和市场优化后可以展示为约 $0.015–$0.025
```

默认解释如下：

- `$0.01` 是中心目标，不是硬性最低值。默认先生成 `$0.008/$0.010/$0.012` 等附近候选；若波动率、成交热区或连续突破缓冲给出充分证据，可以生成更宽候选。
- 下限由模型基于当前价格、成交热区和回撤缓冲选择，不必机械等于当前价。
- 上限由“候选下限 + 目标宽度”产生，再按 Tick spacing 向外或就近对齐。对齐后必须反向解码，记录实际宽度与相对 `$0.01` 的偏差。
- 默认偏好带 `$0.008–$0.012` 是实现默认值，不是永久业务规则。超出偏好带的候选可以存在，但必须显示 `outsidePreferredWidthBand=true`、原因与收益/风险差异；不能悄悄选中。
- 旧 `$0.002628` 宽候选明显偏离本策略目标。若没有可信的宽候选，系统应返回 `RESCAN_NO_TRADE`，而不是回退到该类窄区间。
- PAIR/SPY 池的 Tick 方向与 PAIR/USDG 展示价格相反。实现必须通过同一套标准转换函数完成“价格 → Tick → 价格”回读，禁止凭方向直觉手写加减 Tick。
- SPY/USDG 锚定价格变化会改变同一 PAIR/SPY Tick 对应的 PAIR/USDG 区间。每次模型计算都必须记录所用的 SPY/USDG mark、区块号和时间。

### 3.2 模型不是价格加法器

绝对宽度只负责避免区间过短。候选能否入选仍需综合：

```text
候选净效用
= 预计区间成交量 × 池费率 × 我们的逐 Tick 活跃份额
− LVR / 库存转换风险
− 资本效率稀释
− 建仓、撤仓与主动退出摩擦
− 过快滚仓惩罚
− 数据不确定性惩罚
```

第一版不得使用 Uniswap 页面瞬时 APR 直接选择区间，也不得把“模型手续费捕获”显示为保证收益。

### 3.3 自动更新的准确含义

完成后，正常的仓位生命周期不再需要人工维护数据文件：

1. 钱包新 mint 一个 NFT；
2. 服务从 PositionManager 的 `Transfer` 事件自动发现 tokenId；
3. 在同一安全区块读取 owner、pool key、ticks、liquidity、fees 和余额；
4. 自动判断新建、加仓、减仓、撤空、转入、转出或 burn；
5. 写入持久账本并重新计算组合、策略模型和面板快照；
6. 浏览器下一轮刷新自动展示结果。

`lp-portfolio-overrides.json` 只保留人为名称、策略角色和已确认的资金归因覆盖，不再承担“告诉程序有哪些 NFT”的职责。

#### 3.3.1 选定的技术方案：增量事件索引 + 周期性全量在手对账

不引入第三方 Subgraph 作为正确性的唯一依赖。直接复用当前 `scripts/build-lp-portfolio-ledger.mjs` 已经验证过的一次性链上审计逻辑，把它提取为 Dashboard 进程内的常驻 `PositionInventoryIndexer`：

```text
服务启动
  ├─ 从 SQLite 读取最后安全游标和已知 NFT 集合
  ├─ 若首次升级，从现有 audited manifest 的 safeBlock/known NFTs bootstrap
  └─ 扫描游标后所有 PositionManager Transfer 日志
          ↓
每个安全快照周期
  ├─ safeBlock = head - confirmations
  ├─ 增量扫描 [cursor + 1, safeBlock]
  │    ├─ to=wallet：mint 或转入
  │    └─ from=wallet：转出或 burn
  ├─ 在同一个 safeBlock 回读全部“当前推定在手 NFT”
  │    ├─ ownerOf(tokenId)
  │    ├─ getPositionLiquidity(tokenId)
  │    ├─ getPoolAndPositionInfo(tokenId)
  │    └─ Position/StateView 的 amounts 与 fees
  ├─ balanceOf(wallet) 与 indexedOwnedCount 对账
  ├─ 一个事务写入 events、positions、cursor 与 blockHash
  └─ 生成新的 portfolioVersion/snapshotId
          ↓
Dashboard 自动重算并发布，浏览器按 snapshotId 更新
```

该组合解决不同类型的变动：

| 链上变化                   | 自动发现方式                          | 面板结果                                             |
| -------------------------- | ------------------------------------- | ---------------------------------------------------- |
| 新 mint NFT                | `Transfer(0x0 → wallet)`              | 新增默认命名仓位                                     |
| 外部钱包转入 NFT           | `Transfer(other → wallet)`            | 新增仓位并标记 `external_transfer_in`                |
| NFT 转出                   | `Transfer(wallet → other)` + ownerOf  | 从当前组合移除，历史保留                             |
| NFT burn                   | `Transfer(wallet → 0x0)`              | 标记 burned，历史保留                                |
| 同一 NFT increase          | tokenId 不变；周期回读 liquidity 增加 | 更新本金状态与版本                                   |
| partial decrease           | 周期回读 liquidity 减少               | 更新本金，仍保持 active                              |
| full withdraw、NFT 未 burn | liquidity 变为 0                      | 标记 empty/out，不再作为活跃 LP                      |
| collect only               | fee/余额快照变化                      | 更新未领取费与链上资金流                             |
| Codex 之外的手工操作       | 事件和状态照常发现                    | 链上事实可显示；成本归因先标 `external_unclassified` |

只监听 `Transfer` 不够，因为 increase/decrease 不会产生新 tokenId；只轮询静态 NFT 列表也不够，因为它看不到新 mint。因此“事件索引发现集合 + 每轮状态回读发现集合内部变化 + balanceOf 校验集合完整性”三者必须同时存在。

#### 3.3.2 游标、重组与失败语义

- `nft_events` 以 `(chainId, transactionHash, logIndex)` 唯一，重复扫描不会重复入账。
- cursor 只有在整个区块段的日志、仓位回读和数据库事务都成功后才推进。
- 保存 cursor block hash；若下次发现 hash 不同，回退一个配置窗口后重放。
- `balanceOf != indexedOwnedCount` 时立即发布 `INVENTORY_INCOMPLETE`，保留上一份可信组合用于查看，但停止发布新的 `ROLL/EXIT` 建议。
- RPC 429 或超时不将旧数据伪装成新数据；面板显示最后成功区块、数据年龄与失败原因。
- 静态 `lp-portfolio-ledger.json` 改为由运行时数据库生成的可公开快照/发布产物，不再是服务器识别当前 NFT 的输入真相。

#### 3.3.3 为什么选择该方案

| 方案                                                         | 优点                                             | 代价/风险                                             | 结论                               |
| ------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------- | ---------------------------------- |
| A. 增量 Transfer 索引 + safe-block 状态回读 + balanceOf 对账 | 无第三方依赖；能发现外部手工操作；可复用现有代码 | 需要 SQLite 游标、重组和一致性测试                    | **选定**                           |
| B. systemd 定时运行现有 `portfolio:build` 再重启 Dashboard   | 改动较少                                         | 每次重扫、依赖私有 runs、更新延迟大，仍是文件发布流程 | 只作迁移期兜底                     |
| C. 第三方 Subgraph/Indexer                                   | 查询方便                                         | Robinhood Chain 可用性、延迟和完整性不可控            | 不作 source of truth，可作交叉验证 |
| D. 只轮询当前静态 tokenIds                                   | 很简单                                           | 永远发现不了新 NFT                                    | 不可接受                           |

- 项目已有 Transfer 扫描和同安全区块 owner/liquidity/poolInfo 回读，可提取复用，风险小于另建一套索引器。
- 钱包相关 NFT 数量很小，增量日志加全量在手回读的 RPC 成本可控。
- 不依赖 Robinhood Chain 是否存在稳定的第三方 Subgraph。
- 即使用户在 Uniswap 或其他钱包界面直接操作，链上事件仍会被发现。
- `balanceOf` 只能证明数量，Transfer 日志负责枚举 tokenId，两者互补。

#### 3.3.4 更新频率

- correctness 路径：沿用确认后的 safe block，每 30–60 秒增量扫描和对账。
- 页面路径：继续每 5 秒检查 snapshotId；后端产生新 snapshot 后自动更新。
- 可选快速路径：WSS 或 10–15 秒 head polling 只显示 provisional 变化，不进入账本和交易决策。
- 不要求 Codex 常驻；Codex 只负责发布新代码版本和处理明确的异常，不参与日常数据刷新。

## 4. 当前事实与证据等级

### 4.1 状态术语

| 状态                | 含义                                               |
| ------------------- | -------------------------------------------------- |
| `PROD_VERIFIED`     | 本次通过线上接口或生产回读确认正在生效             |
| `REMOTE_VERIFIED`   | 本次通过 GitHub 只读接口确认仓库、revision 或 CI   |
| `LOCAL_IMPLEMENTED` | 当前目录有实现和测试证据，但没有证明已经发布到生产 |
| `PARTIAL`           | 只覆盖了需求的一部分，关键闭环仍缺失               |
| `NOT_IMPLEMENTED`   | 代码路径或部署单元尚不存在                         |
| `UNKNOWN`           | 当前证据不足，不能声称成功或失败                   |

### 4.2 2026-09-08 线上只读快照

本次通过公开服务回读确认：

- `GET http://47.251.187.250/healthz` 返回 `LIVE`，`refreshMs=60000`，最近成功快照为安全区块 `57401568`。
- `GET /api/snapshot?window=1h` 返回 5 个当前配置内仓位：`#1936443`、`#1983646`、`#1988669`、`#2008008`、`#2073305`。
- `GET /api/portfolio` 返回 22 个静态账本仓位。
- 这证明服务器快照循环在工作，但不能证明当前钱包的所有新 NFT 会被运行时自动发现。

线上数据会漂移，以上只作为方案编写时的证据快照，不作为未来状态承诺。

### 4.3 已落地 / 未落地审计

| 能力                          | 当前状态                   | 证据                                                                                                               | 缺口                                                                 |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 后端定时刷新市场快照          | `PROD_VERIFIED`            | 生产版每 60 秒把市场、动态 inventory 与趋势模型发布为同一 snapshotId；部署后连续读到 3 个前进的安全区块            | 采用轮询而不是流式更新                                               |
| 前端自动轮询                  | `PROD_VERIFIED`            | 可见页面每 5 秒检查 snapshotId；生产浏览器在不 reload 的情况下自动更新区块与生成时间                               | 后端仍每 60 秒才产生新快照                                           |
| systemd 常驻与重启            | `PROD_VERIFIED`            | `dashboard/deploy/pair-liquidity-dashboard.service`；线上 startedAt/health                                         | 只托管面板采集器，没有趋势 Shadow 服务                               |
| 自动发现钱包全部 NFT          | `PROD_VERIFIED`            | 生产 `/api/inventory` 在安全区块核对 balance/indexed/verified=`24/24/24`，并持续推进 Transfer 游标                 | 部署后尚未自然发生新的 mint/转出，仍需下一次真实事件 readback        |
| 自动更新 NFT 生命周期账本     | `PROD_VERIFIED`            | 生产 SQLite 已保存 24 个 state 与逐安全区块 snapshots；刷新时动态合并 manifest                                     | 自动发现仓位的资金来源先保持 `UNKNOWN_EXTERNAL_ORIGIN`，不可伪造成本 |
| 1h/6h 成交量和方向流          | `LOCAL_IMPLEMENTED`        | `lib/trend-lp-signals.mjs`                                                                                         | 仍依赖面板已有 bins 和当前 mark 近似估值                             |
| 成交量 + 流动性 + 份额选区间  | `PROD_VERIFIED`            | 生产 trend v3 以 1h/6h P10/P90 直接生成热区锚点，并评分热区覆盖、模拟份额、流动性稀释与宽度偏差                    | LVR、波动率和滚仓摩擦项待补                                          |
| `$0.01` 左右目标宽度          | `PROD_VERIFIED`            | 生产候选使用 `$0.010000` 中心偏好与约 `$0.008/$0.010/$0.012/$0.015` 候选；页面同时披露 Tick 对齐后的实际宽度和偏差 | 仍需更多极端价格和 SPY/USDG 漂移回放                                 |
| 38 个趋势场景回放             | `LOCAL_IMPLEMENTED`        | `npm run trend:scenarios`、fixture                                                                                 | 需要新增宽区间、锚价变化和连续突破场景                               |
| 跨区间、插针过滤、跳档状态    | `LOCAL_IMPLEMENTED`        | `lib/trend-lp-sequence.mjs`                                                                                        | 尚未作为 7×24 服务持续运行                                           |
| Gas 仅作 `$25` 异常熔断       | `LOCAL_IMPLEMENTED`        | `lib/trend-lp-policy.mjs`                                                                                          | 只是策略规则，不构成链上花费授权                                     |
| 同区块仓位/nonce/面板交叉核验 | `LOCAL_IMPLEMENTED`        | `scripts/pair-trend-shadow.mjs live-once`                                                                          | 是命令式单次/有限次数运行，不是服务                                  |
| 全量撤仓 calldata `eth_call`  | `PARTIAL`                  | Shadow live report                                                                                                 | 只证明撤仓 leg；撤仓 + 换币 + 重建仓位未端到端验证                   |
| 趋势模型 API                  | `PROD_VERIFIED`            | 生产 `/api/trend` 与 `/api/snapshot` 返回同一 `snapshotId`、safe block、`pair-trend-range-v3` 和 Shadow-only 边界  | 仍不是持续状态机或交易执行器                                         |
| 趋势模型可视化                | `PROD_VERIFIED`            | 生产面板已显示当前价、成交热区、活跃 LP、目标区间、候选锚点、资格与首项落选原因；桌面/手机及控制台均验收           | 状态机时间线仍待实现                                                 |
| 7×24 Shadow daemon            | `NOT_IMPLEMENTED`          | 只有 bounded series 命令                                                                                           | 缺调度、持久恢复、锁、告警、运行健康检查                             |
| 自动签名与交易                | `NOT_IMPLEMENTED` 且未授权 | ADR 0003 明确 Shadow-only                                                                                          | 需要单独 ADR、密钥边界、金丝雀和用户授权                             |
| 专用公开 GitHub 仓库          | `REMOTE_VERIFIED`          | `MeiYanDong/robinhood-pair-liquidity`，public；PR #9 已由受保护 `main` 的 2 项必需检查门禁合并                     | 私有运行输出仍不得同步                                               |
| CI 质量门禁定义               | `REMOTE_VERIFIED`          | Actions run `34197017567` 在本次 PR 上通过 `quality` 与 `dashboard-smoke`                                          | CI 不等于生产发布回执                                                |
| 生产部署后 readback           | `PROD_VERIFIED`            | release `20260908T070232Z`、commit `38e30daf...`；health/inventory/trend/浏览器/文件指纹/SQLite 完整性均已回读     | 48 小时观察与下一次真实 mint/撤仓事件仍未完成                        |

结论：动态仓位发现、约 `$0.01` 价格域候选、统一 API 与模型面板已经发布到生产；持续 Shadow 状态机、原子执行与实盘授权仍未闭环。实现与授权是两回事，本阶段固定只读。

### 4.4 本次本地基线验证

完成本地实现后执行的当前基线结果：

- `npm run trend:scenarios`：38/38 场景通过，全部保持 `executionAuthorized=false`；这证明 reviewed fixture 下的确定性行为，不证明未来盈利。
- 私有工作区 `npm test`：103/103 tests 通过；公开仓库 `npm test`：100/100 tests 通过，差异来自仅保留在实盘工作区的操作保护用例。
- 两个工作区 `npm run check`：format、lint、typecheck、tests、public ledger verify、deploy shell check 全部退出码 0。
- `portfolio:verify`：静态账本在安全区块 `56970830` 验证到 24 个 lifecycle NFTs、5 个 active NFTs、148 条 receipts。
- `npm run security:audit:dashboard`：公开面板生产依赖 0 vulnerabilities。
- 真实本地安全区块 `57479821` 上，inventory 的 balance/indexed/verified 为 `24/24/24`；`/api/trend` 返回 v3、25 个候选和固定 `executionAuthorized=false`。
- Playwright 已验证 1440px/390px 布局、1h/6h 交互和自动快照更新；截图只保存在忽略的本地输出目录。

生产补充证据：PR #9 的 Actions run `34197017567` 两项必需检查均成功；合并提交
`38e30daf31d5573252ee27c1acfbc411f6a228a0` 已安装为 release `20260908T070232Z`。生产
`/readyz` 返回 `ready=true`，inventory 为 `VERIFIED` 且 balance/indexed/verified 为
`24/24/24`；浏览器在不重新加载页面的情况下连续显示安全区块 `57497707`、`57498301`、
`57498908`。这些证据足以把新版升级为生产已发布，但不替代 48 小时稳定性观察，也不能证明
尚未发生的下一次真实 mint/撤仓事件。

### 4.5 GitHub 与本地工作区关系

本项目确实已有公开 GitHub 仓库，上一版“当前目录不是 Git 仓库”的表述只描述了文件系统形态，却遗漏了项目 README 已明确记录的发布仓库，现更正如下：

| 层               | 路径/地址                                           | 当前证据                                                        | 职责                            |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- |
| 私有实盘工作区   | `/Users/myandong/Projects/LP`                       | 非 Git root；包含私有 `runs/` 与最新未发布 Shadow 代码          | 链上执行证据、开发与本地验证    |
| 本地公开仓库克隆 | `/Users/myandong/Projects/robinhood-pair-liquidity` | 从 `origin/main` 建立证据文档分支；生产代码基线为 `38e30daf...` | 审查准备、提交与发布打包        |
| GitHub           | `MeiYanDong/robinhood-pair-liquidity`               | `PUBLIC`，默认分支 `main`，生产代码提交 `38e30daf...`           | 公开 source of truth 与 CI 门禁 |

GitHub Actions run `34197017567` 已在 PR #9 上成功完成，`quality` 与 `dashboard-smoke` 均为
`SUCCESS`，随后由受保护分支规则合并。本次公开代码、测试、规划和 Shadow 边界已经同步；私有
`runs/`、数据库、RPC 配置与执行材料没有进入公开仓库。

当前 Dashboard 核心、公开安全的 Trend Shadow modules/tests、`docs/plan.md` 与 `docs/todo.md`
已经选择性同步。`/Projects/LP` 仍保留私有运行证据，禁止把整个父目录、`runs/`、数据库或
凭据复制到公开仓库。

## 5. 产品范围

### 5.1 本轮必须实现的范围

1. 动态钱包 NFT 索引和自动组合对账。
2. 以 PAIR/USDG `$0.01` 左右为目标、可由市场证据上下调整的新趋势区间优化器。
3. 可供面板读取的版本化趋势模型 API。
4. 公开面板中的趋势模型可视化。
5. 常驻、无签名权限的 7×24 Shadow 运行时。
6. 服务健康、数据新鲜度、错误状态、重启恢复和部署后 readback。
7. 针对以上关键路径的测试、CI 门禁、运行手册和变更记录。

### 5.2 后续阶段、需额外授权的范围

1. 自动撤仓、换币、重建 LP。
2. Router allowance 或 Permit 授权。
3. 在服务器加载策略钱包私钥或连接外部签名器。
4. 使用真钱执行约 100U 金丝雀。
5. 将管理资金从金丝雀扩大到现有组合。

### 5.3 明确不做

- 不把 PAIR 现货网格并入本系统。
- 不让 LLM 在热路径临场决定交易。
- 不承诺能处理同一区块内完成的冲高回落。
- 不把历史回放、`eth_call` 或 Shadow 建议冒充交易回执。
- 不在公共服务器或前端代码中保存密钥。
- 不为追求形式而重写整个已有面板或 LP 脚本。

## 6. 目标用户流程

### 6.1 日常查看

用户打开面板即可看到：

1. 当前 PAIR/USDG、SPY/USDG、区块号、数据年龄和证据等级；
2. 钱包内所有当前 PAIR 相关 NFT 及状态；
3. 当前实际 LP 覆盖范围；
4. 模型建议的宽趋势区间和下一档预备区间；
5. 为什么选它、为什么没有选择其他候选；
6. 当前动作建议和是否具有执行权限；
7. 最近的突破、反转、HALT 或恢复事件；
8. 数据是否完整、过期、RPC 不一致或组合未对账。

### 6.2 新建或撤掉 NFT 后

用户通过任意钱包或脚本 mint、撤仓或转移 NFT 后，不做任何面板配置：

- provisional 视图应在 RPC 健康时尽快发现事件；
- safe 视图在达到配置的确认深度后完成最终对账；
- 新仓位自动获得默认名称，例如 `NFT #<tokenId>`；
- 后续若添加人工标签，只覆盖展示元数据，不覆盖链上事实；
- 若链上 `balanceOf` 与索引出的在手 token 数不一致，面板进入 `DEGRADED/INVENTORY_INCOMPLETE`，不静默漏仓。

### 6.3 趋势区间计算

系统每次形成可信快照后：

1. 读取当前 PAIR/SPY Tick 与 SPY/USDG mark；
2. 将市场 Tick bins 转换成 PAIR/USDG 价格 bins；
3. 根据 1h/6h 成交量热区、买卖方向、市场流动性和波动率生成多个价格域下限；
4. 围绕 `$0.010000` 目标宽度生成多个候选，默认重点比较 `$0.008/$0.010/$0.012`；
5. 按 Tick spacing 向外对齐并反向解码验证；
6. 估算每个候选的成交覆盖、活跃份额、手续费捕获、资本效率、库存风险和滚仓摩擦；
7. 过滤不合格候选，给出一个主建议和 2–4 个备选；
8. 生成可解释原因和模型版本；
9. 写入数据库并通过 API 发布。

## 7. 功能需求

### 7.1 FR-INV：自动仓位发现与生命周期索引

#### FR-INV-01：增量事件索引

- 从已持久化游标的下一安全区块开始，扫描 PositionManager 对目标钱包的 ERC-721 `Transfer` 事件。
- 同时处理 `from=wallet` 与 `to=wallet`，识别 mint、转入、转出和 burn。
- 首次启动沿用已有完整账本作为 bootstrap，并从已审计安全区块继续，避免每次从创世块重扫。
- RPC 限流时按可观测的退避策略继续，不得跳过区块后仍宣称完整。

#### FR-INV-02：同区块链上回读

- 对候选 tokenId 在同一 `safeBlock` 读取 owner、position info、pool key、tickLower、tickUpper、liquidity 和可领取费用。
- 当前钱包 `balanceOf` 必须与索引结果交叉验证。
- 对 owner 不是目标钱包或 liquidity 为 0 的仓位保留生命周期记录，但从“当前可管理仓位”集合移除。
- 查询失败时将对应字段标为 `UNKNOWN`，不得用上一次数据伪装当前值。

#### FR-INV-03：重组与重启恢复

- 持久化最近检查点的 block number 与 block hash。
- 若发现 hash 不一致，回退配置的重组窗口后重放。
- 更新必须幂等；同一 `(chainId, txHash, logIndex)` 只能入账一次。
- 进程在写入一半时崩溃，重启后不得漏 NFT、重复生命周期或损坏快照。

#### FR-INV-04：配置职责分离

- 链上事实来自索引器。
- `lp-portfolio-overrides.json` 仅保存 label、role、资金来源分类和经人工确认的说明。
- 新 tokenId 没有 override 时也必须自动显示。
- override 引用不存在 tokenId 时显示配置告警，但不能创建虚假的链上仓位。

### 7.2 FR-RANGE：宽趋势区间优化器

#### FR-RANGE-01：价格域目标宽度

默认配置：

```json
{
  "targetAbsoluteWidthUsdg": 0.01,
  "preferredWidthTolerancePct": 20,
  "candidateWidthMultipliers": [0.8, 1, 1.2, 1.5],
  "minimumCandidateCount": 6,
  "maximumPublishedAlternatives": 4
}
```

有效宽度定义：

```text
targetWidth = targetAbsoluteWidthUsdg
preferredLow = targetWidth × (1 - preferredWidthTolerancePct)
preferredHigh = targetWidth × (1 + preferredWidthTolerancePct)

candidateWidths = unique(
  targetWidth × candidateWidthMultipliers,
  volatilityWidthUsdg,
  continuationBufferUsdg,
  requiredHotZoneCoverageWidthUsdg
)

candidateWidth = one(candidateWidths)
rawHigh = candidateLow + candidateWidth
```

最终 Tick 对齐后记录 `decodedHigh - decodedLow`、与 `$0.01` 的绝对偏差、百分比偏差和 `insidePreferredWidthBand`。模型优先比较 `$0.008–$0.012` 偏好带内的合格候选；偏好带外候选不是自动失败，但必须有波动率、成交热区或连续突破覆盖方面的可解释优势。旧约 `$0.0026` 候选不得作为无提示 fallback；没有合适宽候选时返回 `RESCAN_NO_TRADE`。因浮点误差，宽度和偏差使用最小价格单位或 decimal-safe 比较。

#### FR-RANGE-02：候选下限

候选下限至少来自以下来源：

- 当前价格下方的可配置回撤缓冲；
- 1h 成交量热区的低端分位点；
- 6h 成交量热区的低端分位点；
- 当前已活跃 LP 的连续覆盖边界；
- 近期突破边界与下一档阶梯边界。

离现价太远、无法用当前资产形态建立、或没有有效市场 bins 的候选必须标为不合格并说明原因。

#### FR-RANGE-03：评分与资格

每个候选至少输出：

- PAIR/USDG 下限、上限、绝对宽度、百分比宽度、相对 `$0.01` 的偏差和是否位于偏好带；
- 对齐后的 tickLower、tickUpper、tickSpacing；
- 当前价格在区间的位置；
- 1h/6h 成交量覆盖率；
- 1h/6h 有效市场流动性 bins 数；
- 模拟加入流动性后的成交量加权份额；
- 相对手续费捕获分数；
- 资本效率稀释；
- 波动率缓冲和连续突破缓冲；
- LVR/库存风险代理；
- 预计滚仓摩擦；
- 总分、是否 qualified、未通过原因。

资格过滤先于排序。数据不完整的候选不能仅因分数高而被选中。

#### FR-RANGE-04：两级阶梯输出

模型同时输出：

- `activeTarget`：当前应覆盖的宽主区间；
- `nextTarget`：连续上涨后的下一档预备区间；
- `reservePolicy`：仍留在钱包、尚未部署的 PAIR 份额建议。

第一版只做 Shadow 展示，不自动调动资金。未来的资本比例需要单独批准。

#### FR-RANGE-05：锚价与方向正确性

- 每个建议记录 PAIR/SPY poolId、SPY/USDG 来源、两个引用区块和允许的最大区块差。
- Tick/价格方向必须有单元测试：PAIR 价格上涨时 PAIR/SPY Tick 应按当前池 token 顺序向正确方向移动。
- 若 PAIR/SPY 与 SPY/USDG 数据时间差超过阈值，结果降级为 `STALE_ANCHOR`，不得发布新 `ROLL` 建议。

### 7.3 FR-SIGNAL：趋势与状态机

- 保留现有 1h/6h 量能、PAIR 买入占比、突破幅度、确认区块、确认秒数、活跃覆盖损失和跳档数。
- 增加以 PAIR/USDG 为单位的区间距离：距建议下限、上限及下一个阶梯的绝对/百分比距离。
- 插针必须使用不同区块的可信观测过滤；重复读取同一缓存 generation 不算多次确认。
- 同时支持“普通突破”“强突破”“跨过多个目标”“反转”“数据降级”和“回执待对账”。
- 状态机一次只能产生一个互斥动作；任何 nonce/receipt 不唯一时只能 `RECONCILE_ONLY`。
- Gas 为异常熔断，不因为普通 `$0.5` 与 `$1` 差异等待；超过上限时告警并说明是 Gas 异常，而不是收益判断。

### 7.4 FR-API：版本化公开接口

新增或扩展以下接口：

#### `GET /api/inventory`

返回：

- schemaVersion、chainId、wallet；
- headBlock、safeBlock、cursorBlock、confirmationDepth；
- balanceOf 数量、索引在手数量、是否一致；
- current positions 与 lifecycle summary；
- provisional/safe 标记、ageSeconds、warnings。

#### `GET /api/trend?window=1h`

返回：

- modelVersion、policyVersion、generatedAt、evidenceLevel；
- current price/tick/anchor；
- flowSignals；
- activeTarget、nextTarget、alternatives；
- state、decision、reasons；
- executionAuthorized，第一阶段固定为 `false`；
- data quality、inputs、limitations。

#### `GET /api/snapshot`

- 可内嵌轻量的 inventory/trend summary，减少前端首屏请求竞态。
- 完整明细仍从独立接口读取。
- 所有接口使用同一 `snapshotId` 或明确显示数据来自不同区块，禁止拼接成伪同区块视图。

#### 健康接口

- `/livez` 只证明进程存活。
- `/readyz` 只有在初始 inventory 与 market snapshot 均成功后才为 ready。
- `/healthz` 展示最近尝试、最近成功、各子系统状态和 age。
- 某一个 RPC 短时失败可使用最后一次成功快照，但必须标记 `STALE`；超过阈值不得继续发布新建议。

### 7.5 FR-DASH：趋势模型可视化

#### 主图

横轴统一使用 `PAIR price (USDG)`，并提供 Tick 辅助 tooltip。主图叠加：

- 当前价格竖线；
- 1h/6h 成交量热区；
- 市场逐价格段流动性；
- 我们所有当前 LP 区间与活跃/场外状态；
- 模型 `activeTarget`；
- 模型 `nextTarget`；
- 2–4 个备选区间；
- `$0.01` 目标宽度标尺与 `$0.008–$0.012` 默认偏好带；
- 当前价格到每个边界的距离。

不得只显示 `[106800,108400]` 而不显示其美元含义。

#### 模型解释卡

至少显示：

- 最终建议区间；
- 实际宽度，是否通过 `$0.01` 约束；
- 1h/6h 成交覆盖；
- 预期份额与相对手续费分数；
- 资本效率/LVR/摩擦惩罚；
- 推荐原因与淘汰原因；
- 模型版本和生成时间。

#### 状态机卡

- 当前状态与动作：`HOLD`、`PREPARE`、`ROLL`、`EXIT`、`RECONCILE`、`HALT`。
- `executionAuthorized=false` 必须醒目展示为“建议，不会自动交易”。
- 最近状态转换时间线、触发证据和确认区块数。
- 对 stale、inventory mismatch、RPC divergence、pending nonce 使用明确告警，不用绿色正常状态掩盖。

#### 自动更新体验

- 页面继续自动更新，不要求用户刷新浏览器。
- 若使用轮询，不能叠加未完成请求；页面离开前台时降低非关键请求频率。
- 若采用 SSE，断线后自动回退到轮询。
- 新快照只在 `snapshotId` 变化时重绘，避免 5 秒一次无意义闪烁。
- 保留“最后成功更新时间”和“当前浏览器收到时间”，方便判断服务端是否卡住。

### 7.6 FR-LEDGER：资金与行为归因

至少分开记录：

1. 用户后备资金买入 PAIR 的本金和成交成本；
2. 手续费领取及手续费换成 PAIR；
3. LP 曲线内部 PAIR ↔ SPY 的被动库存转换；
4. 主动 swap 的 PAIR 买入或卖出；
5. mint/increase/decrease/collect 的资产流；
6. Gas、滑点、价格冲击；
7. 相对同库存单纯持有的收益差。

链上可以确认的字段标为 `OBSERVED`；依赖成本归因的字段标为 `LEDGER_DERIVED`；缺失的链外成本保持 `UNKNOWN/PARTIAL`。面板不能用“累计手续费”代替“项目净利润”。

### 7.7 FR-SHADOW：7×24 只读运行时

- 将当前 bounded `series` 改造成独立常驻服务，但保持无签名权限。
- 单实例锁保证只有一个状态推进者。
- 每个建议写入 append-only 决策表，主键包含 modelVersion、snapshotId 和 decisionId。
- 重启从最后已提交状态恢复；重复快照不重复推进确认计数。
- 支持优雅退出，确保 SQLite 事务落盘。
- 健康检查区分数据源失败、模型失败、库存不完整和发布失败。
- 只有状态变化、持续降级或需要人工时告警；稳定 `HOLD` 不刷屏。

### 7.8 FR-EXEC：未来执行层边界

本节用于保证架构不会堵死后续，不属于本轮自动交易授权：

- 优先验证一笔原子完成“撤 LP + 取回资产 + 深度约束 swap”；重建 LP 是否同笔完成取决于实际 Hook/Router 模拟。
- 若必须分两笔，第一笔回执和余额回读成功前不得发送第二笔。
- 每个 intent 只有一个 nonce，未知回执时禁止换 nonce 重发同一经济动作。
- 签名器与公共面板进程、用户和文件系统完全隔离。
- 必须设置允许的 chainId、合约、poolId、token、tokenId、金额、滑点和每日风险额度。
- 任何实盘动作都必须有 txHash、receipt、post-state 和账本写入；缺一项则不是完成。

## 8. 数据架构

### 8.1 数据源

| 数据                      | 主来源                    | 交叉验证                | 用途                       |
| ------------------------- | ------------------------- | ----------------------- | -------------------------- |
| PAIR/SPY Tick、活跃流动性 | Robinhood Chain RPC       | 第二 RPC / 面板旧快照   | 即时价格与市场状态         |
| SPY/USDG mark             | 指定官方池 RPC            | 延迟与价差检查          | 把 PAIR/SPY 转成 PAIR/USDG |
| Swap logs                 | PoolManager               | 区块连续性与 log 唯一键 | 成交量、方向、热区         |
| NFT Transfer              | PositionManager           | wallet `balanceOf`      | 自动发现与生命周期         |
| position info/fees        | PositionManager/StateView | owner/liquidity 对账    | 当前组合                   |
| gas estimate              | RPC fee/estimate          | 模拟结果                | 异常熔断和展示             |
| 手工归因                  | overrides/审计账本        | 用户确认                | 本金与手续费分类           |

### 8.2 建议的 SQLite 表

| 表                   | 关键字段                                                | 说明                   |
| -------------------- | ------------------------------------------------------- | ---------------------- |
| `chain_cursors`      | source, safe_block, block_hash                          | 增量扫描和重组恢复     |
| `nft_events`         | tx_hash, log_index, token_id, from, to                  | 不可重复的生命周期事实 |
| `nft_positions`      | token_id, owner, pool_id, ticks, liquidity, as_of_block | 当前安全视图           |
| `position_snapshots` | snapshot_id, token_id, amounts, fees, status            | 历史可回放快照         |
| `market_bins`        | window, price_low/high, volume, liquidity               | 模型输入               |
| `trend_candidates`   | decision_id, bounds, score components, qualified        | 所有候选而非只存赢家   |
| `trend_decisions`    | decision_id, state, action, reasons, authorized         | Shadow 决策账本        |
| `service_events`     | component, severity, code, details                      | 健康、降级和恢复       |
| `accounting_events`  | source, asset, amount, value, evidence                  | 资金归因               |

数据库迁移必须版本化、可重复执行、有备份和回滚说明。不得直接覆盖线上旧 SQLite 后声称已迁移。

### 8.3 双时间尺度

系统同时保留：

- `HEAD/PROVISIONAL`：用于快速观察价格和新事件，允许随后因重组修正；
- `SAFE/RECONCILED`：用于组合、费用、账本和决策门禁。

面板必须显示当前卡片属于哪一层。未来执行器只可使用通过一致性门禁的快照，不能仅凭 public dashboard 缓存执行。

## 9. 组件架构

```text
Robinhood RPC A/B
      │
      ├── Market Collector ── Swap / Tick / SPY mark ─┐
      │                                                │
      └── Inventory Indexer ── NFT lifecycle / state ─┤
                                                       ▼
                                                Snapshot Composer
                                                       │
                        ┌──────────────────────────────┼──────────────┐
                        ▼                              ▼              ▼
                  Trend Evaluator               Accounting       Health Model
                        │                              │              │
                        └──────────────┬───────────────┴──────────────┘
                                       ▼
                              SQLite + JSON API
                                       │
                              Public Dashboard

Future only:
Trend Decision ──> Intent/Simulation ──> Isolated Signer ──> Receipt/Post-state
```

关键隔离：

- Collector 与 Dashboard API 可以同服务部署，但模块必须可独立测试。
- Shadow Evaluator 不导入私钥，不依赖执行脚本的环境变量。
- 未来 Signer 使用独立 systemd unit、Unix user 和凭证目录。
- API 只发布经过脱敏、可公开的数据。

## 10. 自动更新时序与 SLO

目标 SLO 在部署前需通过实际 Robinhood Chain 区块时间和 RPC 配额校准，第一版目标为：

| 项目                        | 目标                               |
| --------------------------- | ---------------------------------- |
| 页面感知新的已发布 snapshot | 10 秒内                            |
| HEAD 价格年龄               | 正常时不超过 20 秒                 |
| SAFE 市场/费用快照          | 正常时不超过 90 秒                 |
| NFT safe lifecycle 更新     | 达到确认深度后 120 秒内            |
| 服务重启恢复                | 3 分钟内恢复 ready 或明确 DEGRADED |
| stale 告警                  | 数据年龄超过阈值后的一个采集周期内 |

这些是验收目标，不是当前已实现事实。若 RPC 配额无法支持，必须通过批量读取、事件增量和双速率采集解决，不能简单把失败隐藏成旧数据。

建议节奏：

- 价格/head：10–15 秒；
- 安全市场快照：30–60 秒；
- NFT 生命周期：每个安全快照增量扫描；
- 组合费用重读：60 秒，或发现生命周期变化时立即触发；
- UI：5 秒检查 snapshotId，必要时 SSE 推送。

## 11. 风险与失效处理

| 风险                | 检测                             | 系统行为                                    |
| ------------------- | -------------------------------- | ------------------------------------------- |
| RPC 429/超时        | 请求错误和连续失败计数           | 退避、切备用 RPC、标记 stale                |
| 两 RPC Tick 分歧    | 同区块或邻近区块比较             | 不发布新风险建议，`RPC_DIVERGENCE`          |
| NFT 清单不完整      | `balanceOf != indexedOwnedCount` | `INVENTORY_INCOMPLETE`，停止 ROLL/EXIT 建议 |
| 区块重组            | checkpoint block hash 变化       | 回退并重放，撤销 provisional 事件           |
| SPY 锚价过期        | anchor age/block gap 超阈值      | 不生成 PAIR/USDG 新目标                     |
| Tick 方向或对齐错误 | round-trip invariant 失败        | 拒绝发布候选并告警                          |
| 模型无合格候选      | qualification 为空               | `RESCAN_NO_TRADE`，不硬选最高分             |
| 数据库写入失败      | 事务异常                         | 保持上一成功快照并标记发布失败              |
| 进程重启            | systemd + persisted state        | 幂等恢复，不重复确认或事件                  |
| 浏览器拿到混合快照  | snapshotId 不一致                | 分区显示或等待一致快照                      |
| 同一区块插针        | 链下无法在区块内反应             | 明确能力边界，不承诺触发价                  |
| 未来回执未知        | nonce/receipt 对账               | HALT，不盲目重发                            |

## 12. 安全与公开边界

- 当前面板可公开；公开数据包括池、价格、NFT、范围、模型建议和历史统计。
- 禁止公开 RPC 密钥、钱包私钥、签名服务地址、未广播 raw transaction、服务器凭证和敏感日志。
- Nginx/应用限制请求体、超时与并发，API 返回安全错误，不输出堆栈或环境变量。
- 依赖安装使用锁文件，CI 运行 production dependency audit。
- 建议后续为公开站点配置域名和 HTTPS；当前裸 IP HTTP 可用，但不能提供传输完整性保证。
- 公共面板被攻破不得获得任何交易能力，这是架构级验收条件。

## 13. 测试方案

### 13.1 单元测试

- PAIR/USDG ↔ PAIR/SPY Tick 往返与方向测试。
- `$0.015143` 起点的中心候选结束在 `$0.025143` 左右，并同时生成目标附近备选的测试。
- Tick 对齐后正确报告实际宽度、与 `$0.01` 的偏差和偏好带状态的边界测试。
- SPY/USDG 锚价变化时价格范围重算测试。
- 无 bins、零流动性、无效负数、极端小价格和极端宽度测试。
- 评分组件、资格先于排序、平分 tie-break 测试。
- 自动 NFT 事件去重、owner 变化和 balance mismatch 测试。
- 状态机重复 block、插针、连续突破、跳两档、重启恢复测试。

### 13.2 集成测试

- 用 fixture 模拟 mint → increase → partial decrease → collect → full withdraw → transfer/burn。
- 从旧游标启动，扫描缺口区块并与 `balanceOf` 对账。
- 注入区块 hash 变化，验证 rewind/replay。
- 断开一个 RPC，验证备用源和 degraded 标签。
- 快照写到一半杀进程，验证事务恢复。
- API schema snapshot 测试，防止前端和后端静默漂移。

### 13.3 前端与视觉验收

- 宽区间主图必须展示 `$0.015143 → 约 $0.025` 的中心候选及其上下浮动备选 fixture。
- 主图在桌面和移动尺寸均能辨认当前价、现有 LP、activeTarget 和 nextTarget。
- stale、Shadow-only、inventory incomplete 不可只靠颜色表达。
- tooltip 的 Tick 与价格应与 API 相同，不在浏览器重新使用另一套公式。
- 自动刷新不得重复创建计时器、叠加请求或丢失用户选择的时间窗口。

### 13.4 Shadow 验收

- 至少 48 小时连续只读运行；期间重启一次验证恢复。
- 至少 20 种场景，现有 38 种必须继续通过，并补充宽区间相关场景。
- 新 NFT 无人工改 JSON 即进入 safe 组合。
- 模型建议与决策账本一一对应，页面可以回查 decisionId。
- 无签名、无授权、无广播证据；任何交易 RPC 调用均视为失败。

### 13.5 未来实盘验收

只有单独批准后才进入：

- 原子或严格分阶段 calldata 在固定区块模拟成功；
- 独立策略钱包、单 NFT、约 100U 金丝雀；
- 至少 7 天且完成 3 次完整状态转换；
- 每次动作有 intent、txHash、receipt、post-state；
- 对比同库存持有的净超额收益、最大回撤、费用、滑点、Gas 和冻结延迟；
- 未出现重复 nonce、未知回执盲重发或未记账资产。

## 14. 部署与运行方案

### 14.1 发布单元

建议保留现有 `pair-liquidity-dashboard.service`，新增无权限的 `pair-trend-shadow.service`：

- Dashboard service：采集、索引、API、静态页面；
- Shadow service：读取同一 SQLite 的已提交快照或内部只读 API，推进模型状态并写建议；
- 两者使用独立锁和清晰的 SQLite 写入所有权，避免并发写冲突；若共库不安全，则拆成 collector DB 与 shadow DB。

第一版也可以将 Shadow evaluator 放入 collector 单进程，但必须保留模块边界和独立健康状态。是否拆 unit 以故障隔离和实际 SQLite 并发测试结果决定，不为了形式提前微服务化。

### 14.2 发布步骤

1. 在本地完成全量检查和 fixture 回放。
2. 生成 release 目录，不包含 `.env`、runs 私有日志或密钥。
3. 备份服务器 SQLite 和当前 release，验证备份可读。
4. 安装新 release，先启动只读服务。
5. 检查 `/livez`、`/readyz`、`/healthz`、`/api/inventory`、`/api/trend`。
6. 对比服务器直读与本地同区块读取。
7. 观察至少两个刷新周期，确认 generatedAt、safeBlock 和 inventory cursor 前进。
8. 浏览器验证模型图层与自动更新。
9. 失败时切回上一 release 和兼容数据库；不得删除原数据库冒充回滚。

### 14.3 Git 与 CI 现状

本项目已有专用公开仓库 `https://github.com/MeiYanDong/robinhood-pair-liquidity`，本地 clean clone 位于 `/Users/myandong/Projects/robinhood-pair-liquidity`。`/Users/myandong/Projects/LP` 是同一项目的私有实盘工作区，不是 Git root。因此：

- 可以在私有工作区开发、运行带私有 receipts 的审计并做本地验证；
- 公开安全的代码、测试和文档需要选择性同步到现有专用仓库；
- 只有公开仓库目标 commit 的 GitHub Actions 通过，才能声称远端 CI 覆盖本次变更；
- 发布包的 `GIT_COMMIT` 必须来自该公开仓库已验证的 commit；
- 同步时不得把其他项目、私钥、`.env`、runs 或私人审计数据带入公开仓库。

## 15. 分阶段交付

### 阶段 P0：需求与证据基线

产出本文与 `docs/todo.md`，冻结术语、范围和验收口径。

### 阶段 P1：自动 Inventory

先消除静态 manifest 依赖。只有系统自动知道“我们有哪些仓位”，后续趋势模型和面板才有可信基础。

### 阶段 P2：价格域宽区间优化器

把固定 Tick 宽度改成 PAIR/USDG 候选，以 `$0.01` 为中心生成上下浮动候选，并实施波动率/热区调节、Tick 对齐和评分解释。

### 阶段 P3：统一快照与 API

将 inventory、market、model、health 使用 snapshotId 和 schemaVersion 串起来，避免前端拼接不一致数据。

### 阶段 P4：面板可视化

实现主图图层、候选比较、状态机、证据等级和自动更新体验。

### 阶段 P5：7×24 Shadow 服务

持续运行，不签名；验证重启、RPC 故障、stale、事件重组和告警。

### 阶段 P6：生产发布与观察

发布公开只读系统，进行运行时 readback 和 48 小时观察。到此仍不交易。

### 阶段 P7：执行可行性研究

构造并模拟完整撤仓/换币/重建路径。只有证据完整后才提交新的执行 ADR。

### 阶段 P8：受限金丝雀与扩容

需要用户明确批准钱包、资金、资本比例、退出规则和签名边界后才能开始。

## 16. 验收标准

本轮只读产品完成的 Definition of Done：

1. 当前和新 mint 的 PAIR 相关 NFT 无需改配置即可自动出现。
2. `balanceOf` 与索引在手 token 数持续对账；不一致时面板明确降级。
3. 主目标围绕 `$0.010000` 生成并显示实际宽度与偏差；默认优先选择 `$0.008–$0.012` 偏好带，超出时必须有可见理由，不能退回无提示的约 `$0.0026` 窄区间。
4. 模型仍使用成交量、市场流动性、份额和波动率，不退化为固定价格加法。
5. 面板能同时看到当前价、市场热区、我们的 LP、主目标、下一目标、备选、分数和原因。
6. 页面和后端自动更新，新增/撤仓无需 Codex 手工同步。
7. 所有卡片带生成时间、区块、evidenceLevel 和 modelVersion。
8. Shadow 服务在 RPC 故障、重启、stale 和库存不一致时按设计降级并恢复。
9. lint、format、typecheck、unit/integration tests 和 dashboard smoke 在本地通过；同步到真实 Git 仓库后 CI 也通过。
10. 线上 `/healthz`、`/api/inventory`、`/api/trend` 与浏览器 readback 通过，连续观察不少于 48 小时。
11. 公共服务不存在私钥、签名或广播能力。
12. 实盘执行仍保持未授权，除非后续单独 ADR 和用户明确指令改变这一状态。

## 17. 仍需在实盘执行前决策的事项

以下问题不会阻塞 P1–P6 的只读开发，但会影响 P7–P8：

### D1：执行资金和钱包边界

- 影响：最大可损失资产与账本复杂度。
- 方案：独立策略钱包；有限几个现有 NFT；整个当前钱包。
- 推荐：独立策略钱包或严格限定 NFT/额度的签名边界。
- 不回复：继续只读开发，不部署签名器。

### D2：两级阶梯的资本比例

- 影响：当前手续费效率、连续突破覆盖和钱包预留。
- 方案：`60/25/15`（当前/下一档/预留）；`50/30/20`；动态优化。
- 推荐：金丝雀先用 `60/25/15`，但不在只读阶段移动资金。
- 不回复：面板展示建议比例，不执行。

### D3：反转阈值与卖出比例

- 影响：假突破被洗出与大跌风险。
- 方案：全部退出；50%+50% 两段；只撤 LP 不卖币。
- 推荐：历史回放后使用“两段退出”，阈值先作为未批准参数展示。
- 不回复：Shadow 记录反事实动作，不交易。

### D4：原子执行路径

- 影响：撤 LP 到 swap 之间的价格与故障空窗。
- 方案：Universal Router 原子路径；两笔回执门禁；专用受限合约。
- 推荐：先验证 Router 原子路径，失败再比较另外两种。
- 不回复：只做 calldata 和 `eth_call`，不授权、不广播。

### D5：告警渠道

- 影响：HALT、持续 stale 和执行异常能否及时被看到。
- 方案：仅面板；邮件/飞书；多渠道。
- 推荐：正式执行前至少一个主动渠道；只读阶段可以先用面板和结构化日志。
- 不回复：不阻塞 P1–P6。

### D6：公开同步范围

- 影响：GitHub CI 覆盖范围、可追溯发布以及私有 receipts/凭证泄漏风险。
- 已确定：使用现有 `MeiYanDong/robinhood-pair-liquidity`，不新建第二个仓库。
- 待执行：逐文件同步 Dashboard、Shadow、tests 和公开文档；排除 `runs/`、`.env`、密钥、RPC 凭证和私人审计原始数据。
- 不回复：可以准备和验证同步差异；提交/推送仍按用户对本项目的发布授权和现有流程执行。

## 18. 变更控制

以下变化必须更新本文或新增 ADR：

- `$0.01` 目标宽度、默认容差或其含义改变；
- 从 PAIR/SPY 固定池扩展到自动跨 PAIR/USDG/SPY 路由；
- Shadow 获得签名、广播、allowance 或资金移动能力；
- 管理资金范围扩大；
- 风险退出由建议变为自动执行；
- 公共服务器开始持有任何敏感凭证；
- 会计口径改变，导致历史收益可比性中断。

需求实现顺序、逐项文件、命令与验收门禁见 [`docs/todo.md`](./todo.md)。

## 19. 独立实盘账户的只读投影扩展

后续已在独立仓库和独立服务器上线的 `PAIR / USDG 有限马丁实盘` 不改变本文原趋势执行器的
授权状态。本公开面板只增加一个跨账户 read model，采用以下固定边界：

- 配置公开钱包、pool 和 Transfer 扫描起点，不配置会随换档变化的 NFT tokenId；
- 为每个外部策略使用独立 SQLite identity 和游标，避免污染原钱包的历史总账；
- 每轮在同一安全区块核验 `balanceOf/ownerOf/liquidity/pool-info`，并读取本金与未领取 feeGrowth；
- 自动展示新增、撤走、burn 和替换仓位，成本基础没有公开证据时保持 `UNKNOWN`；
- 私钥、待签 intent、nonce 恢复状态、告警凭证和私有 Keeper 日志不进入面板服务器；
- 外部策略状态独立降级，主钱包已有可信快照不因一次正常的两笔换档短窗被整体判为不可用。

该扩展采用 snapshot schema v5 与 `/api/strategies`，详细取舍见
[`ADR 0004`](./adr/0004-external-strategy-accounts.md)。
