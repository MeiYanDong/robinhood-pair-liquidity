# PAIR Trend LP Keeper 可执行任务清单

- 来源：[`docs/plan.md`](./plan.md)
- 日期：2026-09-08
- 当前范围：自动仓位发现、宽区间模型、面板可视化、7×24 Shadow；不含实盘授权
- 勾选规则：只有代码、测试和对应证据都完成时才可勾选；“本地通过”不能代替“生产已发布”

## 状态说明

- `[x]`：已有证据且已在当前审查范围内验证。
- `[ ]`：尚未完成或尚缺验收证据。
- `BLOCKED-AUTH`：必须有用户新的明确授权后才能做。
- `BLOCKED-DECISION`：需要会改变资金、风险或发布源的决定。

## 阶段 0：需求、现状与工程基线

### 0.1 需求基线

- [x] 建立 `docs/plan.md`，写明 `$0.01` 左右的目标绝对宽度、价格域建模、自动更新和可视化需求。
- [x] 将“自动刷新页面”和“自动发现钱包 NFT”定义为两个独立验收项。
- [x] 明确 Shadow、模拟、链上回执和账本证据边界。
- [x] 明确普通 `$0.5/$1` Gas 差异不阻塞动作，保留 `$25` 异常熔断策略。
- [x] 明确纯 LP、趋势 Keeper 和现货网格互不混用。

### 0.2 当前实现审计

- [x] 确认后端已有 `PAIR_DASHBOARD_REFRESH_MS` 定时刷新。
- [x] 确认前端已有 5 秒轮询。
- [x] 确认生产 `/healthz` 为 `LIVE` 且后端刷新间隔为 60 秒。
- [x] 确认生产 `/api/snapshot` 当前只展示 5 个配置内仓位。
- [x] 确认 `/api/portfolio` 仍来自 22 条静态账本记录。
- [x] 定位根因：`PairDashboardCollector` 只在构造时加载一次 manifest 和 position configs。
- [x] 确认当前趋势候选仍是固定 8/12/16 个 tick spacing，不满足新宽度规则。
- [x] 确认当前趋势模型没有公开 API 和面板图层。
- [x] 确认 `/Projects/LP` 是非 Git 的私有实盘工作区，并确认现有公开仓库为 `MeiYanDong/robinhood-pair-liquidity`。

### 0.3 文档门禁

- [x] 将 `docs/plan.md` 和 `docs/todo.md` 加入根项目 `format:check` 范围。
- [ ] 给文档内的需求 ID 增加自动链接/引用检查，防止 todo 与 plan 漂移。
- [x] 更新 `CHANGELOG.md`，说明这是只读趋势模型与面板改造，不是自动交易上线。
- [x] 若架构边界变化，新增 ADR；否则在 ADR 0003 中链接本计划而不重复整篇内容。

#### 阶段 0 验收

- [x] 运行 `npx prettier --check docs/plan.md docs/todo.md`。
- [x] 运行 `npm run format:check`。
- [x] 人工核对所有 `[x]` 项都有文件或线上 readback 证据。

## 阶段 1：自动 Inventory Indexer

目标：新建、撤走、转移或烧毁 NFT 后，服务器自行更新，不再运行 `npm run portfolio:build` 才能被面板看见。

### 1.1 数据库与迁移

- [x] 确认可复用源：`scripts/build-lp-portfolio-ledger.mjs` 已有 `scanTransfers()` 与同安全区块 `ownerOf/getPositionLiquidity/getPoolAndPositionInfo` 审计。
- [x] 设计 inventory schema migration，单链/单钱包数据库中包含 cursor meta、Transfer events、current states 与 position snapshots。
- [x] 为 `(tx_hash, log_index)` 建唯一约束；chain/wallet 由数据库 identity 隔离，保证事件幂等。
- [x] 为 `(token_id, as_of_block)` 与 `(as_of_block, token_id)` 建仓位快照主键/索引。
- [x] 记录 cursor block hash，支持重组检测。
- [x] 编写从当前已审计 `lp-portfolio-ledger.json` 的 known NFTs、safeBlock 和 safeBlockHash bootstrap 的一次性迁移器。
- [x] bootstrap 前要求 manifest 为 `verified_complete_at_safe_block` 且 blockHash 可回读；不满足时执行完整补扫而不是强行接续。
- [ ] 保留原 JSON 和数据库备份，不直接覆盖唯一历史证据。
- [ ] 增加 schema version 与向前迁移测试。

### 1.2 增量 Transfer 扫描

- [ ] 从一次性 builder 提取通用 `scanPositionManagerTransfers()`，避免复制两套方向、chunk 和 retry 逻辑。
- [x] 在 `dashboard/lib/` 新增独立 `position-inventory.mjs` 持久化与纯函数模块。
- [x] 从持久 cursor 的下一块扫描 PositionManager `Transfer` 日志。
- [x] 同时扫描 `from=wallet` 和 `to=wallet`，合并后按 block/transaction/logIndex 排序。
- [x] 识别 mint、转入、转出、burn，保留完整 lifecycle。
- [x] 复用现有 RPC gate、批量窗口和退避逻辑。
- [x] 任一区块范围读取失败时不推进 cursor。
- [x] 将每轮扫描进度写入 service health，而不是只写 stdout。

### 1.3 同安全区块仓位回读

- [x] 每个安全快照都回读全部“推定在手 NFT”，因为 increase/decrease 不会产生新的 ERC-721 Transfer。
- [x] 在单一 `safeBlock` 上读取每个候选 NFT 的 owner、position info、pool key、ticks 和 liquidity。
- [ ] 读取并记录可领取手续费与当前 token amounts。
- [ ] 通过相邻快照 liquidity 变化识别 increase、partial decrease 和 full withdraw；链上未提供完整资金归因时标记 `observed_state_delta`。
- [x] 用钱包 `balanceOf` 交叉验证索引出的 owned token 数。
- [x] 数量不一致时设置 `PARTIAL`/`BALANCE_MISMATCH`，触发完整补扫并禁止 readiness。
- [x] owner 已转出或 liquidity 为 0 时更新 lifecycle，不从历史账本删除。
- [x] 非 PAIR 相关 NFT 进入全钱包 inventory，但默认不加入 PAIR 策略视图。

### 1.4 动态配置与 collector 集成

- [x] 移除 `PairDashboardCollector` 构造后永久固定 `pairPositionConfigs` 的假设。
- [x] 每个安全刷新周期从 inventory store 生成当前 position set。
- [ ] 保留 `lp-portfolio-overrides.json` 的 label/role/归因覆盖能力。
- [x] 新 tokenId 无 override 时自动显示 `链上发现 NFT #<tokenId>`，并将成本归因保留为 `UNKNOWN`。
- [ ] override 指向不存在 tokenId 时发出配置告警，不创建虚假仓位。
- [x] 每个安全刷新周期发现 lifecycle 变化后在同一快照内重算组合。
- [x] 将 `lp-portfolio-ledger.json` 降级为可验证 bootstrap 与历史会计输入，不再作为运行时 NFT 注册表。

### 1.5 重组与恢复

- [x] 检查 cursor block hash；不一致时从审计起点重放。
- [x] 对重复事件与乱序日志写纯函数/SQLite 幂等测试。
- [x] 在事件写入与 cursor 推进之间使用同一事务。
- [x] 验证 repository 重建后游标与事件不丢失、不重复。
- [x] 将 bootstrap、catch-up、rebuild 与常规 build 进度暴露到 health progress。

### 1.6 Inventory API

- [x] 实现 `GET /api/inventory`。
- [x] 返回 schemaVersion、snapshotId、head/safe/cursor blocks 和 runtime 数据年龄。
- [x] 返回 balanceOf、indexedOwnedCount、match 状态和 warnings。
- [x] 返回 current positions 和 lifecycle summary，不暴露敏感配置。
- [x] 增加 API 路由、只读边界与错误脱敏静态契约测试；生产 schema readback 仍待发布。

#### 阶段 1 验收

- [ ] fixture 完成 `mint → increase → partial decrease → collect → withdraw → transfer/burn` 全链路。
- [ ] 不修改 JSON 配置即可让 fixture 新 NFT 出现在 `/api/inventory`。
- [x] 不产生 Transfer 的 increase/decrease 也能在下一个 safe snapshot 自动更新。
- [x] liquidity 归零但 NFT 仍归钱包时，自动从 active positions 移出且历史记录保留。
- [x] 注入 inventory mismatch 后，API 与面板均明确降级。
- [x] 本地安全区块 `57439562` 直读得到 `balanceOf=24`、推导持有 `=24`、成功复核 `=24`。
- [x] 运行根项目完整 `npm test`，覆盖 dashboard、runtime、inventory 与趋势模型测试。

## 阶段 2：PAIR/USDG 宽区间优化器 v2

目标：废弃固定 1,600/2,400/3,200 Tick 主候选逻辑，使趋势主区间以 `$0.010000` 左右为中心，并由市场数据在目标附近上下调整。

### 2.1 Decimal 与价格转换基础

- [ ] 提取唯一的 PAIR/SPY Tick ↔ PAIR/USDG 转换模块，前后端共用输出而非重复公式。
- [ ] 明确 token0/token1、decimal 和价格方向，写入模块注释与测试名称。
- [ ] 使用整数最小单位或可靠 decimal 比较宽度，避免 `0.1 + 0.2` 类浮点边界。
- [x] 实现“价格域 bounds → 向外 Tick 对齐 → 价格域 round-trip 验证”。
- [ ] 对齐后若宽度变窄，继续扩一个 tickSpacing 直到约束通过。

### 2.2 候选生成

- [x] 新增 `targetPriceWidthUsdg=0.01` 的版本化配置。
- [x] 新增 `targetWidthTolerancePct=20`，默认偏好带为 `$0.008–$0.012`。
- [x] 新增默认 width multipliers `[0.8, 1, 1.2, 1.5]`。
- [x] 从当前价与 70%/80%/90%/100% 上行空间生成候选下限。
- [x] 从 1h 成交热区 P10 下沿与 P90 上沿生成价格域候选锚点。
- [x] 从 6h 成交热区 P10 下沿与 P90 上沿生成价格域候选锚点。
- [ ] 从当前 LP 连续覆盖边界生成候选下限。
- [ ] 从最近突破边界/下一档生成候选下限。
- [ ] 将波动率宽度、连续突破缓冲和热区覆盖宽度并入 `baseWidth`。
- [x] 去重相同 width multiplier，并用 Tick 对齐后的边界稳定候选。
- [x] 保证合格候选数量不足时返回 `RESCAN_NO_TRADE`，`activeTarget=null`，不伪造可执行最优解。

### 2.3 候选度量与评分

- [x] 复用 1h/6h 成交量覆盖计算。
- [x] 复用逐 bin 市场流动性与模拟份额计算。
- [x] 增加绝对宽度偏差和等本金流动性稀释项。
- [ ] 增加 LVR/库存风险代理，并把公式和局限写入输出。
- [ ] 增加滚仓频率/Gas/滑点摩擦项，但不恢复 8 小时费用门禁。
- [x] 资格过滤先于生成 `activeTarget`；不合格 winner 仅保留为 leading candidate。
- [x] 输出总分和每个组成项，避免黑箱分数。
- [x] API 输出全部候选及资格检查/落选原因；面板显示前三名、锚点来源、PASS/FAIL 与首项原因。

### 2.4 两级阶梯

- [x] 输出通过资格门槛的 `activeTarget`，无合格候选时为 `null`。
- [x] 输出与 activeTarget 受控重叠且零意外空隙的 `nextTarget`。
- [ ] 输出 reservePolicy 建议，但第一阶段固定 `executionAuthorized=false`。
- [x] 输出两档 overlap/gap，并用测试确认默认无意外价格空隙。
- [x] 下一档固定标记 `PREPARE_ONLY`，不伪称交易建议。

### 2.5 必测用例

- [x] 输入 `$0.015143` 下限时，100% 上行候选 raw high 为 `$0.025143`，Tick 对齐后仍向外覆盖。
- [x] Tick 对齐后输出 decoded width 与相对 `$0.010000` 的偏差；偏好带由版本化配置输出。
- [x] 测试要求生成候选实际宽度不低于约 `$0.0075`，旧窄区间不会成为无提示 fallback。
- [ ] SPY/USDG 上涨/下跌时，同一 Tick 的 PAIR/USDG bounds 正确变化。
- [ ] 极端低 PAIR 价格下 `$0.01` 宽度导致巨大百分比区间时仍稳定计算并显示风险。
- [x] 无市场 liquidity bins 时不 qualified，返回 `RESCAN_NO_TRADE`。
- [ ] 宽区间覆盖更多量但份额下降时，分数拆解可解释。
- [ ] 连续跳过两档时只给一个宽 catch-up tranche 建议。

#### 阶段 2 验收

- [x] 由 `dashboard/lib/trend-model.mjs` v3 模块替代旧 selector，根模块只做稳定 re-export。
- [x] 更新 `test/trend-lp-signals.test.mjs`。
- [x] 纳入 `test/fixtures/trend-lp-breakout-scenarios.json`，现有 38 场景不回归。
- [x] 运行 `npm run trend:scenarios`，38/38 通过并保存本地忽略的报告。
- [x] 根项目 `npm test` 已覆盖 trend signals/policy/sequence。

## 阶段 3：统一快照与趋势 API

### 3.1 Snapshot contract

- [x] 定义 snapshot schemaVersion 4、snapshotId 与 trend modelVersion；独立 policyVersion 仍属后续执行策略。
- [ ] 每个字段标明 `PROVISIONAL`、`SAFE`、`MODELLED`、`LEDGER_DERIVED` 或 `UNKNOWN`。
- [ ] 记录 PAIR/SPY 区块、SPY/USDG 区块及最大允许 gap。
- [x] inventory 不是 `VERIFIED` 时 `/readyz` 不通过，health 显示 `DEGRADED` 而非绿色就绪。
- [ ] 写 JSON schema/fixture 和 backward compatibility 测试。

### 3.2 Trend evaluator 集成

- [ ] 将 flow signals、sequence signals、wide range candidates 和 policy decision 组合为单一 decision。
- [ ] 每个 decision 生成稳定 decisionId。
- [x] 保存并通过 API 返回所有候选，不只保存 winner。
- [x] 将 `executionAuthorized=false` 写入服务端固定边界并测试。
- [ ] 对 stale anchor、inventory mismatch、RPC divergence 和 pending nonce 显式降级。

### 3.3 API

- [x] 实现 `GET /api/trend`，模型同时携带固定 1h/6h 输入；窗口化路由参数留待统一状态机。
- [ ] 支持当前面板已有的窗口选择，至少 1h/6h 输入可追溯。
- [x] 在 `/api/snapshot` 加同一 snapshotId 下的 trend/inventory read model。
- [x] `/api/trend` 和 `/api/inventory` 返回稳定的 503 unavailable 结构，inventory partial 使用 206。
- [ ] 增加 ETag 或 snapshotId，前端可以跳过无变化重绘。
- [x] 更新 `/healthz`，分别报告 market/inventory/trend/publisher 子系统。
- [x] 更新 `/readyz`，只有当前进程成功发布且 inventory 为 `VERIFIED` 时 ready。

#### 阶段 3 验收

- [ ] API fixture 中显示 `$0.015143–约 $0.025` 的中心 activeTarget 与上下浮动备选。
- [x] API 同时返回 activeTarget、nextTarget 和所有 candidates。
- [x] API 明确显示 `READ_ONLY_SHADOW` 与 `executionAuthorized=false`。
- [ ] API schema snapshot test 通过。
- [x] `curl /api/trend`、`curl /api/inventory`、`curl /healthz` 在真实安全区块 `57479821` smoke 通过。

## 阶段 4：面板趋势可视化

### 4.1 主图层

- [x] 新增趋势主图，横轴统一为 PAIR/USDG 价格；原市场图继续保留 Tick tooltip。
- [x] 绘制当前价格竖线。
- [x] 绘制当前所选窗口成交柱与 6h P10–P90 热区。
- [ ] 绘制市场流动性分布。
- [x] 绘制我们的每个 active LP 区间；完整状态仍由下方仓位卡区分。
- [x] 绘制 activeTarget/leading candidate 宽区间，并由状态文字区分是否 qualified。
- [x] 绘制 nextTarget `PREPARE_ONLY` 虚线区间。
- [ ] 绘制备选区间，可开关避免主图拥挤。
- [x] 文本显示 `$0.01` 中心偏好、默认 `$0.008–$0.012` 带和实际宽度偏差；独立图上标尺仍可增强。
- [ ] 显示当前价到上下界的绝对和百分比距离。

### 4.2 解释与状态卡

- [x] 增加模型版本、全局生成时间/引用区块和独立证据等级。
- [x] 增加成交覆盖、模拟份额与宽度偏差；LVR 和摩擦分解仍待后续模型增强。
- [x] 增加候选锚点、资格 PASS/FAIL、完整 title 原因和首项落选原因。
- [ ] 增加状态机当前状态、动作和最近转换时间线。
- [x] 醒目显示“Shadow 建议，不会自动交易”。
- [x] stale 与 inventory mismatch 使用文字状态而非只依赖颜色；RPC divergence/pending nonce 待统一状态机接入。

### 4.3 自动更新体验

- [x] 页面按 `snapshotId + selectedWindow` 判断是否需要重绘。
- [x] 避免上一请求未完成时再发同一路由请求。
- [x] 浏览器后台把轮询降至 30 秒，回到前台立即刷新。
- [x] 显示服务器快照时间与相对数据年龄；独立 browser receivedAt 字段仍可增强。
- [ ] 可选实现 SSE；断线时自动回退到轮询。
- [x] 新 NFT safe 后由服务器 inventory 进入下一快照，前端五秒轮询自动展示，不要求 Codex 更新。

### 4.4 可访问性与响应式

- [x] Playwright 在 1440px 桌面宽度验证主图、读数与候选不遮挡。
- [x] Playwright 在 390px 手机宽度验证图表、卡片和候选仍可读；图例无需折叠即可容纳。
- [x] 趋势图提供建议区间、宽度、热区、流向和候选文本替代。
- [ ] 键盘可操作窗口切换和图层开关。
- [x] 复用现有 price/percent/money formatter，低价不显示为 0。

#### 阶段 4 验收

- [ ] 使用固定 fixture 截图，对比当前 LP、activeTarget、nextTarget 和热区位置。
- [x] Playwright 切换 1h/6h 后，成交额、swap 数、标题与 selected tab 同步变化，控制台无应用错误。
- [x] inventory mismatch 单元测试与 UI verification 文案 fail closed；stale 继续复用现有 runtime 测试。
- [x] 连续提供相同 snapshotId 时跳过 DOM/图表重绘。
- [x] 可见页面每 5 秒轮询，新 snapshotId 的设计 SLO 小于 10 秒；生产观察仍待发布。
- [x] dashboard model contract、完整根测试和真实浏览器 smoke 通过。

## 阶段 5：7×24 Shadow 运行时

### 5.1 服务化

- [ ] 把 bounded series 的核心提取为可长期运行的 service loop。
- [ ] 保持命令行 `live-once` 和 `series` 作为诊断工具。
- [ ] 添加单实例锁，第二实例启动时只报告冲突而不推进状态。
- [ ] 采用事务持久化 sequence state 和 decision。
- [ ] 重复 snapshotId 不增加 confirmationBlocks。
- [ ] SIGTERM 时完成当前只读事务并优雅退出。
- [ ] 明确禁止导入任何 private key/WalletClient/broadcast transport。

### 5.2 健康与告警

- [ ] 为 market、inventory、trend、database、publisher 分别维护状态。
- [ ] 只有状态变化、持续 stale、HALT 或恢复时发告警。
- [ ] 稳定 HOLD 不重复通知。
- [ ] 结构化日志包含 snapshotId、decisionId、block 和 reason code。
- [ ] 日志轮转并限制磁盘占用。

### 5.3 systemd 与权限

- [ ] 新增或明确选择 `pair-trend-shadow.service`。
- [ ] 使用无登录、无密钥、最小文件权限的 systemd user。
- [ ] 限制可写目录到 Shadow 状态目录。
- [ ] 添加 Restart、RestartSec、内存和文件句柄限制。
- [ ] 添加 systemd service 语法检查和部署 smoke。

#### 阶段 5 验收

- [ ] 本地连续运行至少 2 小时，无内存/句柄持续增长。
- [ ] 人工杀进程后自动重启并恢复，不重复决策。
- [ ] 注入 RPC 失败后进入 DEGRADED，恢复后继续。
- [ ] 连续读取同一 dashboard generation 不算多区块确认。
- [ ] 代码搜索证明 Shadow runtime 没有签名和广播路径。

## 阶段 6：历史回放与故障演练

### 6.1 宽区间历史反事实

- [ ] 在同一历史窗口比较旧窄区间与新 `$0.01+` 宽区间的成交覆盖。
- [ ] 比较资本效率稀释、模拟份额和潜在滚仓次数。
- [ ] 不把 swap-only replay 标成真实历史手续费或真实 PnL。
- [ ] 输出模型版本、输入区块范围和缺失数据说明。

### 6.2 至少 20 类行情场景

- [ ] 轻微触碰上轨后回落。
- [ ] 单区块插针。
- [ ] 缓慢连续突破。
- [ ] 强量能突破。
- [ ] 弱量无跟随突破。
- [ ] 连续跳过两个旧窄区间。
- [ ] 新宽区间内持续上涨。
- [ ] 完整穿越 activeTarget。
- [ ] activeTarget 穿越但 nextTarget 已覆盖。
- [ ] 两档都被快速穿越。
- [ ] 突破后 V 型反转。
- [ ] 突破后缓慢反转。
- [ ] 上涨中 SPY/USDG 锚价突变。
- [ ] 市场流动性热点迁移。
- [ ] 成交量高但我们的份额极低。
- [ ] 数据 stale。
- [ ] 两 RPC 分歧。
- [ ] inventory mismatch。
- [ ] pending nonce/unknown receipt。
- [ ] Gas 普通波动 `$0.5→$1`。
- [ ] Gas 超过 `$25` 异常线。
- [ ] 进程重启恰逢突破确认。
- [ ] 区块重组撤销 provisional 突破。
- [ ] 无合格候选。

### 6.3 混沌与恢复测试

- [ ] 随机注入 RPC 429、timeout 和 malformed response。
- [ ] 注入 SQLite busy/只读/磁盘空间告警。
- [ ] 注入服务器时间偏移，验证使用链上 block time 与明确的 receivedAt。
- [ ] 注入 API schema 不兼容，前端显示错误而非空白。
- [ ] 验证任何不唯一状态都不会生成 executable intent。

#### 阶段 6 验收

- [ ] 所有确定性场景 action 与 reviewed expectation 一致。
- [ ] 报告说明“反事实模型”而不是“盈利证明”。
- [ ] 恢复测试没有重复事件、重复 decision 或游标越过失败区块。

## 阶段 7：CI/CD 与生产发布

### 7.1 本地质量门禁

- [x] `npm run format:check` 通过。
- [x] `npm run lint` 通过。
- [x] `npm run typecheck` 通过。
- [x] `npm test` 通过；私有工作区 103 项、公开仓库 100 项。
- [x] `npm run portfolio:verify` 通过：24 个 lifecycle NFTs、5 个 active NFTs、148 张回执。
- [x] `npm run deploy:check` 通过。
- [x] `npm run security:audit:dashboard` 通过：0 vulnerabilities。
- [x] `npm run trend:scenarios` 通过：38/38。
- [x] 新增 dashboard API/visual smoke 通过；截图保存在本地忽略的 `output/playwright/`。

### 7.2 Git source of truth

- [x] 确认专用公开 Git 仓库为 `MeiYanDong/robinhood-pair-liquidity`，默认分支为 `main`。
- [x] 确认本地公开仓库 clone 位于 `/Users/myandong/Projects/robinhood-pair-liquidity`，审查时 HEAD 为 `b6b05cccab8e6146fbdb4cbf543f42fb3f945210`。
- [x] 确认该 SHA 的 GitHub Actions CI run `34081630851` 成功；该结果仅覆盖已公开基线。
- [x] 核对目标仓库为独立 clean clone，没有复制父目录其他项目或私人 `runs/` 数据。
- [x] 检查 `.gitignore` 覆盖 `.env`、keys、runs、reports、数据库、备份和本地审计材料。
- [x] 以 dashboard/read-model/tests/docs 最小差异同步，没有复制整个父目录。
- [ ] 使用清晰提交信息，说明 data/model/dashboard/ops 分层。
- [ ] 验证 GitHub Actions 真正在目标 commit 上运行，而不是只存在 workflow 文件。

### 7.3 服务器部署

- [ ] 备份当前 release 与 SQLite。
- [ ] 验证备份可读取并记录恢复命令。
- [ ] 上传无密钥 release。
- [ ] 运行数据库迁移 dry-run。
- [ ] 安装并重启只读服务。
- [ ] 检查 systemd active、PID、最近日志和资源占用。
- [ ] 检查 `/livez`、`/readyz`、`/healthz`。
- [ ] 检查 `/api/inventory` 的 balanceOf 对账。
- [ ] 检查 `/api/trend` 的 `$0.01` 目标宽度、偏差说明和 Shadow-only 标记。
- [ ] 浏览器验证模型图层与自动更新。
- [ ] 观察至少两个刷新周期，确认 block、generatedAt、cursor 前进。
- [ ] 若任一门禁失败，切回上一 release；保留新旧数据库用于调查。

### 7.4 生产观察

- [ ] 连续 48 小时保持只读 Shadow。
- [ ] 记录 RPC 失败率、snapshot age、inventory mismatch 次数和 restart 次数。
- [ ] 至少执行一次服务重启恢复演练。
- [ ] 若期间发生真实 mint/撤仓，验证无需 Codex 更新即可显示。
- [ ] 形成 48 小时运行报告，列出完成、降级、未知与未覆盖情形。

#### 阶段 7 验收

- [ ] 目标 Git commit、CI run、release id、服务器 readback 可以互相对应。
- [ ] 线上页面数据更新不依赖手工 JSON/HTML 发布。
- [ ] 公共服务器没有签名和广播能力。

## 阶段 8：完整执行路径研究（仍只模拟）

- [ ] 枚举 Robinhood Chain 当前 PositionManager、Universal Router、Hook 的确切地址和 bytecode hash。
- [ ] 构造完整撤仓 + TAKE + swap 的候选 calldata。
- [ ] 在固定区块 `eth_call`，记录 input、result、gas estimate 和 revert reason。
- [ ] 评估能否同笔 remint 新宽区间。
- [ ] 若不能原子完成，设计严格的两笔 receipt gate 与超时恢复。
- [ ] 计算深度感知的 minOut，不使用固定百分比拍脑袋。
- [ ] 对未知 receipt、nonce 冲突、部分余额和 Hook revert 做恢复设计。
- [ ] 新增执行 ADR，比较 Router 原子路径、分阶段路径和受限合约。
- [ ] 保持所有输出 unsigned，禁止创建 allowance 或广播。

#### 阶段 8 验收

- [ ] 每条候选路径都有精确 calldata 和固定区块模拟证据。
- [ ] 明确哪些步骤已证明、哪些仍 `UNKNOWN`。
- [ ] 未经批准没有链上状态变化。

## 阶段 9：实盘金丝雀（BLOCKED-AUTH）

以下全部默认不执行：

- [ ] `BLOCKED-AUTH`：用户明确选择执行钱包/受管 NFT。
- [ ] `BLOCKED-AUTH`：用户明确批准资本上限和单次额度。
- [ ] `BLOCKED-AUTH`：用户明确批准两级阶梯资金比例。
- [ ] `BLOCKED-AUTH`：用户明确批准反转阈值和两段卖出比例。
- [ ] `BLOCKED-AUTH`：用户明确批准 signer/Router allowance 边界。
- [ ] `BLOCKED-AUTH`：用户明确批准主动告警渠道。
- [ ] 使用独立钱包、单 NFT、约 100U 金丝雀。
- [ ] 每次动作记录 intent、signed hash、txHash、receipt、post-state。
- [ ] 任何 receipt/nonce 不唯一时 HALT，不盲目重发。
- [ ] 至少运行 7 天并经历 3 次完整状态转换。
- [ ] 对比同库存持有的净超额收益、最大回撤、费用、滑点、Gas 和冻结延迟。

## 阶段 10：扩容（BLOCKED-AUTH）

- [ ] 金丝雀所有验收项通过。
- [ ] 外部审查签名、allowance、nonce、receipt 和恢复边界。
- [ ] 第一轮扩容不超过当前项目资产的 15%。
- [ ] 建立每日损失、累计滑点、Gas、调用次数和资产额度。
- [ ] 建立一键 disarm，但 disarm 不删除账本或未决 intent。
- [ ] 扩容后重复 7 天和 3 次转换验收。

## 需求到任务映射

| 需求               | 对应任务阶段                |
| ------------------ | --------------------------- |
| FR-INV 自动仓位    | 1、3、7                     |
| FR-RANGE 宽区间    | 2、3、4、6                  |
| FR-SIGNAL 趋势状态 | 2、3、5、6                  |
| FR-API 公开接口    | 1、3、7                     |
| FR-DASH 可视化     | 4、7                        |
| FR-LEDGER 资金归因 | 1、3、6；完整会计另立故事卡 |
| FR-SHADOW 常驻     | 5、6、7                     |
| FR-EXEC 未来执行   | 8、9、10                    |

## 推荐的下一批小型故事卡

按依赖顺序开始，避免同时改动所有模块：

### Story A：运行时自动发现新 NFT

- [x] 实现 inventory schema、cursor 和 Transfer 扫描。
- [ ] 验收：fixture 新 NFT 无配置即可从 `/api/inventory` 读到。

### Story B：`$0.01` 价格域候选

- [x] 实现价格域生成、热区锚点、向外 Tick 对齐和 round-trip invariant。
- [x] 验收：`$0.015143` 的中心候选上限约为 `$0.025`，可解释地展示上下浮动，旧窄区间不再作为无提示 fallback。

### Story C：趋势 API

- [x] 实现 versioned activeTarget/nextTarget/candidates read model；统一状态机 decision 仍属阶段 3.2。
- [ ] 验收：接口明确显示数据区块、模型版本、宽度和 Shadow-only。

### Story D：主图模型图层

- [x] 把市场、当前 LP、主目标、下一目标和热区画在同一 PAIR/USDG 轴上。
- [ ] 验收：桌面/手机截图与数值 fixture 一致。

### Story E：无需 Codex 的生产刷新

- [ ] 部署动态 inventory + model pipeline，完成真实 mint/撤仓 readback。
- [ ] 验收：不改仓位 JSON、不重新构建 HTML，线上在 SLO 内自动展示变化。

## 当前下一步

Story A–D 的本地实现和门禁已经完成；当前下一步是本地真实 API/浏览器 smoke、Git commit 与 CI、生产备份部署和至少两个刷新周期 readback。完成生产证据前，不把本地结果描述为线上全自动。
