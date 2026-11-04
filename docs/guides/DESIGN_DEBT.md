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
