# 设计债与模块边界（DESIGN_DEBT）

> 本文记录 `fix/design-debt` 分支的设计原则、已完成的拆分、以及仍然存在的结构性缺陷。
> 它不是功能说明；功能与安全边界见 [../../RULES.md](../../RULES.md) 与
> [SECURITY_BASELINE.md](SECURITY_BASELINE.md)。

## 为什么要专门处理设计债

`src/bridge.js` 是历史演进的单文件主程序：截至本分支开始时约 **11.8k 行**，`main()`
内部有 **200+ 个嵌套函数**，HTTP 端点、社交状态机、唤醒调度、媒体处理、语音、控制台
全都共享同一个闭包。它跑得很稳，但带来了三个可量化的代价：

1. **不可直接测试**：测试只能把 `bridge.js` 当源码字符串塞进 `vm`，手工注入几十个
   符号。每次新增一个 import，所有 VM 夹具都要跟着补，漏一个就是“测试全红但生产正常”。
2. **规则没有单一来源**：例如 HTTP 的 agent/管理端权限矩阵过去散落在 4 段 `if` 里，
   新增端点时很容易只改了其中一处。
3. **改动半径不可控**：任何跨功能改动都要在 12k 行的同一闭包里推理，无法用模块边界
   隔离回归。

## 已完成的拆分（本分支）

| 模块 | 接口 | 解决的重复/风险 | 回归 |
| --- | --- | --- | --- |
| `src/route-policy.js` | `authorizeAgentRequest()` + 路由分类函数 | 把「身份 × 路由」矩阵从 `bridge.js` 的 100+ 行嵌套 `if` 收成一张默认拒绝的策略表；管理端点不会再因为漏写一行校验而暴露给会话 agent | `scripts/test-route-policy.mjs`（11 项） |
| `src/json-file.js` | `readJsonSafe` / `readConfigObject` / `atomicWriteJson` / `atomicWriteText` / `renameWithRetry` | 48 处调用点共享同一套「BOM 容错、配置顶层校验、唯一临时文件、Windows rename 退避」实现，避免各端点各写一份 | `scripts/test-json-file.mjs`（6 项） |
| `src/config.js` | `loadConfig()` + `normalizeOwnerQQ` / `normalizeIdList` / `normalizeReasoningEffort` / `applyRoleInjectLimit` | 350 行配置默认值、section 合并、socialV2 深度合并从 `main()` 外移；配置可以脱离桥接进程直接测 | `scripts/test-config.mjs`（5 项） |
| `src/http-utils.js` | `SECURITY_HEADERS` / `sendJsonResponse` / `readJsonBody` / `isAllowedHost` / `isAllowedOrigin` | 安全响应头、1MB 请求体读取、Host/Origin 回环校验从每个请求闭包外移；可脱开真实 HTTP server 单测 | `scripts/test-http-utils.mjs`（4 项） |
| `src/initial-prompts.js` | `createInitialPromptStore()` | 初始提示词的加载/保存/只读降级/上限校验从 `main()` 外移；文件损坏时不覆盖原文件的约束可以单测 | `scripts/test-initial-prompts.mjs`（5 项） |
| `src/roles.js` | `createRoleStore()` + `sanitizeRoleName` / `validateRoleContent` | 人格卡的列目录、名称/体积校验、读写、注入预警/摘要从 `main()` 外移；注入上限通过 getter 动态读取 | `scripts/test-roles.mjs`（5 项） |
| `src/http/role-routes.js` | `handleRoleRoutes()` | `startConsoleServer()` 的人格管理路由组（7 个端点）整块外移；依赖显式传入 | `scripts/test-role-routes.mjs`（5 项） |
| `src/http/preset-routes.js` | `handlePresetRoutes()` | `startConsoleServer()` 的仿真提示词路由组（读取/保存/备份/还原）整块外移 | `scripts/test-preset-routes.mjs`（4 项） |
| `src/social-v2/wake-policy.js` | `normalizeSpeakerIdsV2` / `pickWakeTriggersV2` / `defaultWakeConfigV2` / `preSleepWaitBlockedV2` / `computeWakeSafetyV2` / `wakePriorityV2` 等 | reserved2 唤醒策略的纯函数层：默认配置、触发字段过滤、沉睡前观察判定、防永眠、优先级；bridge 只留绑定 `cfg.socialV2.wake` 的薄包装 | `scripts/test-wake-policy.mjs`（8 项） |
| `scripts/audit-bridge-harness.mjs` | `bridgeHarness()`（测试专用） | 补注入 `role-card` / `inbound-message` / `route-policy` / `json-file` / `config` / `http-utils` / `initial-prompts` / `roles` / 路由组 / `wake-policy`（含 import-as 别名）；修复“新增模块后 VM 里 `selectRoleText is not defined`”导致的连锁失败 | `npm run test:audit` 44/44 |

修复后基线：`npm run test:audit` **64/64 全绿**（修复前为 26/35，含多个因 VM 缺符号而
超时/误报的脚本）。`bridge.js` 从 11,822 行降到约 7,900 行。

## 仍然存在的设计债（按优先级）

### P0 — `bridge.js` 拆分进度（2026-11-03）

已完成外移（均带直接单测，`npm run test:audit` 64/64 全绿）：
`route-policy` / `json-file` / `config` / `http-utils` / `initial-prompts` / `roles` /
`http/role-routes` / `http/preset-routes` / `http/security-routes` / `http/dsh-routes` /
`http/access-routes` / `http/social-routes` / `http/notify-routes` / `http/token-routes` /
`http/lifecycle-routes` / `http/socialv2-admin-routes` / `http/socialv2-session-routes` /
`http/socialv2-send-routes` / `http/socialv2-sticker-routes` / `http/voice-routes` /
`http/socialv2-wait-route` / `http/memory-routes` / `http/socialv2-misc-routes` /
`http/socialv2-read-routes` / `http/slang-routes` / `http/send-routes` /
`social-v2/wake-policy` / `social-v2/state-store` / `social-v2/wake-scheduler`。
`startConsoleServer()` 的全部尾部端点（check-send、tool-log、feedback、my-recent、
record-sent、message-detail、forward-message/media、active-members、group-members、
slang、authorize/read、images/message、`/api/send/*`）已全部外移完成。
`unquoteJsonString` 纯函数已从 bridge.js 移入 `http-utils.js`；
reserved2 状态读写（getSocialV2State/load/save）已迁入 `social-v2/state-store.js`
（工厂注入 ensureWakeable/定时器/令牌回调；多实例写覆盖保护有直接单测钉住）；
reserved2 唤醒调度（sendWakePrompt/scheduleWake/setupSleepTimer/scheduleReplyCheck/
scheduleProactiveCheck/replayPendingWakeReasons/isConversationBusy/clearTimers）已迁入
`social-v2/wake-scheduler.js`（工厂注入 deliverPrompt/buildWakePrompt/判忙上下文；
合并窗口优先级升级、限频延后重试、失败回滚+有限睡眠恢复、回放分流、判忙租约
等定时器语义全部有 mock-timers 直接单测钉住）。

**P0 拆分到此完成**：`startConsoleServer()` 之内已无业务路由体，reserved2 的
状态与调度全部落在 `src/social-v2/` 的三个深模块（wake-policy / state-store /
wake-scheduler），bridge.js 剩余部分是消息管道、prompt 构建与 DSH 会话编排。
后续可选（非 P0）：把 `startConsoleServer()` 的「deps 组装 + http.createServer 壳」
再抽成 `src/http/console-server.js`，让 bridge.js 完全不感知 HTTP 层。

每一步必须满足：`node --check src/bridge.js` 通过、`npm run test:audit` 全绿、
新增模块有直接单测（不经过 VM 源码注入）。

### P1 — `config.example.json` 仍是手写模板

`loadConfig()` 已迁到 `src/config.js`，默认值只剩这一份；但 `config.example.json` 还是
另一份手写模板，两者靠人工同步。下一步由 `src/config.js` 的默认值生成
`config.example.json`，并加一个键集合/类型契约测试（敏感字段必须为空）。

### P1 — 状态文件各自手写加载/保存

`initial-prompts.json` 已抽到 `src/initial-prompts.js`（带只读降级单测）；`sessions.json`、
`social-v2.json`、`slang.json`、`stickers.json` 仍各自重复「读失败 → 只读降级 / 损坏 → 不覆盖」
的样板。下一步抽 `src/json-store.js`（`createJsonStore({file, fallback, onCorrupt})`），
统一可写标志与原子落盘，并把剩余存储逐个迁过去。

### P2 — 测试仍有一部分是源码字符串断言

`test-voice.mjs` 等用 `bridge.includes('...')` 找端点，属于过渡手段。随着模块外移，
这些断言应改为导入模块并断言接口；在完成前，**新增源码字符串断言需要说明为什么无法
用模块接口替代**。

## 改动规则

1. 新端点默认只给控制台；要暴露给 agent，必须在 `route-policy.js` 显式列入白名单并
   补 `test-route-policy.mjs` 用例。
2. 任何「读整份配置 → 改一个字段 → 写回」的代码必须走 `readConfigObject()` +
   `atomicWriteJson()`，禁止手写 `JSON.parse(fs.readFileSync(...))` 回写。
3. 新增 `bridge.js` 顶层 import 时，同步更新 `scripts/audit-bridge-harness.mjs` 的
   VM 注入（直到 P0 完成）；否则会在测试里表现为 `xxx is not defined`。
4. 纯函数/文件 I/O 优先放进独立 `src/*.js`，测试直接 `import`，不要再塞进 `main()`。

## 仓库布局与协作（fork 说明，2026-11-04）

本仓库是 `Derpyu520/qq-bridge` 的 fork，由 Neukas（GitHub: meltingBlue3）维护自己的路线：

- **origin** → `github.com/meltingBlue3/qq-bridge`（自己的 fork，推送目标）
- **upstream** → `github.com/Derpyu520/qq-bridge`（原作者，只 fetch 用来对比/吸收更新）
- **main** = 自己的主路线（fork 时按本地 main 强推覆盖，**不追上游 main**）
- **fix/design-debt** = 2026-11 的 P0 拆分线（26 个深模块、`test:audit` 64/64、
  真实桥接实测通过）。日常魔改从这条线拉开发分支。

⚠️ 与上游的关系：fork 后上游又前进了 ~70 个提交，且双方改过同一批文件
（上游把人格注入也重构了，本仓库的 `plugins/qq-persona` 与配套 preset 在上游已不存在；
本仓库 prompt 变量名为 `qq_persona`——DSH 0.2.x 起强制全小写 snake_case）。
合并上游是一次有冲突的正式工程，**不要顺手 merge**；需要时单独开一轮，
重点比对：人格注入方式、`plugins/` 三个 bundle、MCP 版本与工具清单、表情库。

另：`dsh` CLI 未装进 PATH，`scripts/setup-dsh.mjs` 里的
`dsh plugin --profile web install` 步骤会以退出码 1 跳过——不影响使用，
脚本已手动物化两层 junction（`~/.dsh/plugins/<name>` 与 profile `node_modules/<name>`），
形态与 install 结果一致。

## 上游更新吸收（2026-11-04，只取行为不搬代码）

上游 `v0.2.1-r2`（a49877f..upstream/main，70 提交）做了一轮大安全审计。本仓库按
「**只吸收行为/功能点，实现全部自己写**」的原则逐项移植——一是架构不同（26 个深模块
vs 上游单体），二是上游已改为 PolyForm-Noncommercial 许可，复制代码会有许可传染。
侦察结论存档：跳过 #118（角色卡按节奏注入）——我们走 `qq_persona` system prompt
全卡注入，模型每回合见完整卡，上游要解决的「人设只给名字」问题在我们的架构下不存在。

### 已落地（每项独立提交 + 直接单测）

| 提交 | 内容 | 对应上游 |
| --- | --- | --- |
| `07ce38a` | wait 429 带 `retryAfterMs` 倒计时 + 「不要立刻重试」+ 沉睡观察出口提示 | #24 剩余项 |
| `1eb5f3d` | wake-config 的 `batchWindowMs` 不传时跟随全局（不再被会话旧值钉死） | #93 之二 |
| `1458aad` | 断线恢复的回合只保留 45s 忙碌宽限（`src/turn-lease.js`）；不再重启后按满租约判忙 | #93 之一 |
| `a332fde` | messageId 幂等入库（切片查重 + 进程内 LRU 500，`src/social-v2/message-id-dedupe.js`） | #84 之一 |
| `c5c82d4` | 繁忙积压的**点名类**唤醒（@/私聊/名字/拍一拍）已读也补发（已读≠已回应）；无效暂存条目丢弃续取 | eca88d5 之一 |
| `6d31743` | 撤回事件（group_recall/friend_recall）：入库消息原地换占位（保 seq），清引用/媒体/转发三个派生缓存（`src/social-v2/recall.js`） | #84 之二 |
| `38a613f` | `qq_get_prompt` 的 role.hint 返回真实卡文（原来是「请调工具却拿不到」的死胡同）；config 示例 maxInjectChars 对齐 8000 | b8199c2 |
| `295912f` | 令牌出站审计改**片段级匹配**（`src/token-fragment.js`，12 字符滑窗）：拆条发令牌也拦得住 | #79 |
| `eccebdf` | 挂起提问只消费管理员消息（owner 门）；预设补【会话隔离】硬规则 | #86 |
| `a5a4d34` | 媒体抓取端口白名单（80/443/8080/8443，重定向每跳复检）+ forward-media **会话登记**（`src/social-v2/forward-media-registry.js`，只抓本会话见过的媒体） | #85 |
| `450f6ea` | 群友可控文本入模前结构净化（`sanitizeUntrustedText`：【】降级/换行压空格/零宽剥离；落点在 compactModelMessage + compactModelData 任意层字符串） | #78 |
| `a77f5e2` | web_search/web_fetch 结果套不可信数据外壳 + 6000 字符截断 | #82 |
| `332a060` | agent 视角隐藏成员管理员身份（isOwner/role）；userId 默认保留（拍一拍/点名工具需要），`privacy.exposeUserId=false` 可隐藏 | #88（取舍：上游默认藏 userId 会打断工具链） |
| `2d59678` | 发送队列**按会话分链**（`sendChains` Map）：跨会话并行互不阻塞、同会话五条路径严格保序、链尾清理；顺带 sendMessagesV2 失败也记 lastSendFailed | #83 |
| `b2422b7` | AI 通道**发送前重查**静默/暂停/关闭（出站瞬间生效）；操作者通道不受限；auditAndSend 失败丢弃且不发通知 | 5551e74 |
| `7c8027e` | 普通聊天并入 per-session 投递队列：提交顺序=到达顺序（修「后到文本先于带图消息」）；ack 语义保留 | 0ac4233 之二 |
| `2d8023a` | 表情/黑话**按会话 scope 隔离**：AI 创建归属会话、注入只含 global+本会话、重检测 scope-aware、AI 收藏归属收藏会话；旧数据按 global 兼容 | #87 |

### 有意跳过（理由）

- **#118 角色卡节奏注入**：我们的人格卡走 `{{qq_persona}}` system prompt 注入，每回合
  全卡在场、无历史重复注入可省；移植反而把卡拉回消息正文，是退步。
- **CI/治理类**（LICENSE 换非商用、SECURITY.md、issue 模板、PR 守护）：个人 fork 不需要。
- **stop-bridge-instance.mjs**：本机单实例 + start.bat 守护，无双实例风险面。
- **6455d60/24e29ba**：其父功能（会话绑定/表情 scope fail-closed）未在本仓库，单独做无意义。

### 待吸收（下次继续，按价值排序）

1. **断线出站交付游标补发**（0ac4233 之一，L）：持久化交付游标 + 重连快照补发
   已完成回合；**必须**先做 modeKnown（真实模式确认前只暂存快照），否则 reserved2
   内部文本会被当普通回复外泄。触发条件建议：实际遇到「断线窗口内回复永久丢失」再动工。
2. 小件（纯防御，S）：定时器限幅、敏感检测伪装归一化（NFKC/零宽）、DSH 端点运行时自愈、preset bundle 同步。
3. 另行评估：qq-self-key 执行期会话绑定（把 key 从「模型自律」改为「exec.agent.id 派生」）。

> 结论：上游 10-31 安全审计批次里**用户可感知的功能/安全面已全部吸收**（17 项，
> 每项独立提交+直测）。剩余项要么是纯防御加固，要么是 L 级可靠性工程且触发条件
> 尚未出现——留作后续轮次，见上表。

## 会话方反馈吸收（2026-11-05，QQ 使用方实测痛点）

QQ 侧长期使用者反馈 5 个问题，逐项修复（每项独立提交 + 直测）：

| 提交 | 反馈 | 内容 |
| --- | --- | --- |
| `54e2053` | ② seq/messageId 双 ID 易填错 | 后端其实早已全双寻址（reply/detail/images 都按 seq 命中），缺的只是没人告诉模型——MCP 描述统一声明「QQ 消息 id 或本地 seq 皆可，桥接自动换算」，唤醒提示词【引用】段同步 |
| `fbb8fed` | ① 快照/未读/最近重复出现烧 token | 新增**已展示回执**（`src/social-v2/receipts.js`，进程内、投递被接受才登记）：唤醒快照的未读与 recent 切片、unread 默认读取、recent 路由全部跳过已展示的；未 mark_read 的积压不再每回合重发全文；显式 afterSeq 分页保持精确窗口 |
| `2191932` | ③ unreadCount 与 readThroughSeq 对不上（显示 9 条其实 1 条新） | **双口径**：`unreadCount`=缓冲总量（含已展示待确认），`newUnreadCount`=调用时还没见过的；快照 XML/state/prompt/unread/wait/mark-read 全部并列两个数，提示词写「未读 N 条（新 M）」 |
| `abbd814` | ⑤ 沉睡前强制等 5 分钟太磨人 | 观察窗口**按活跃度自适应**（10 分钟内来信 ≥6 条保满、3-5 条减半、≤2 条缩到 1/5；地板 `preSleepWaitMinMs` 默认 60s）+ 显式配置 `preSleepWaitMs` 是上限（自适应只缩短）；preset/MCP 去掉硬编码 300000，改指向返回的 hint |
| `b01844b` | ④ 动图抽帧依赖 ffmpeg | **纯 JS GIF 解码 + PNG 编码**（`src/media/gif-decode.js` / `png-encode.js` / `gif-mosaic.js`，零依赖）：ffmpeg 缺失/失败时 animate 路径自动兜底，动图表情不再只剩首帧 |

> 设计取舍：已展示回执**不落盘**（重启后模型重新拉取，与 readThrough 凭证分开）；
> recent 去重只对 agent 生效（控制台要全量历史）；自适应窗口**只缩短不拉长**
> （测试把窗口配成几百毫秒时语义不变）。
