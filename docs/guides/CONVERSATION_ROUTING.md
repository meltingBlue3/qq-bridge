# 逐会话路由接入记录

主程序、管理 API 和控制台现已接入逐会话路由。升级代码不会自动改动现有模式或给 owner
增加工具权限：需重启桥接加载新代码、安装并重启 DSH 加载新 preset，再到控制台的
「逐会话模式」选择「迁移并启用」。代码回归使用隔离目录与虚拟 QQ/DSH；另外已用用户
提供的两个账号验证 QQ ↔ OneBot 双向私聊。尚未迁移或重启真实桥接，DSH 端到端仍待验收。

启用后，群聊可以使用仿真策略，owner 私聊单独使用 `closed-agent`。策略文件缺失时继续
使用原全局模式；文件损坏时拒绝投递与创建，不回退为具有完整工具的默认模式。

## 安装产物

`scripts/setup-dsh.mjs` 从 `src/preset-patches.js` 的清单生成并安装五套 preset：

| preset | 协议与工具面 |
| --- | --- |
| `qq-chat` | 旧聊天/一代仿真；共用仿真工具守卫 |
| `qq-chat-v2` | 旧二代仿真；由发送工具交付文字，共用仿真工具守卫 |
| `qsh-sim`、`qsh-sim-v2` | 规范路由名称；初始沿用二代协议，各有独立可编辑源文件，共用仿真工具守卫 |
| `qsh-closed` | 仅 owner 私聊；保留本地工具，使用独立的 QQ 工具可见性守卫 |

源文件在 `dsh/agent-presets/<id>/`，产物在 `plugins/qq-agent-presets/presets/`。
两个命名世代同时保留；规范 preset 不是运行时别名。改其中一套提示词不会隐式修改其他套。
生成器校验 preset 与守卫匹配，防止仿真 preset 错装封闭模式守卫。

```sh
node scripts/build-agent-preset-patches.mjs --check
npm run test:routing
```

安装器的临时目录测试覆盖五套 preset 同时安装、旧配置保留和过期产物重建。
这不能替代真实 DSH 的加载与工具注册验收。当前环境缺少可扫描的 DSH 工具包，
该项仍显式跳过。管理 API 会重新读取实际 preset 清单，确认加载成功后才允许迁移；
找不到 `qsh-closed` 时不得回退为默认 preset。

## 策略与审计存储

`src/core/conversation-policy-store.js` 使用共用 JSON 存储保护，文件路径由调用者提供，
现使用 `state/conversations.json`。策略和审计一起原子替换，保存成功后才发布内存状态。
文件缺失时不写文件、不默认为 owner 开启本地执行；文件损坏、审计结构损坏或外部改写时
拒绝覆盖。瞬时写入失败可以重试；外部冲突需确认文件后重新加载。

文档记录 `enabled`、`ownerQQ`、策略快照、递增 `revision`、完整 `audit` 和迁移时的旧模式
快照。迁移不修改原 `mode.json` 或 `config.json`。旧仿真模式不会在迁移中自动给 owner
增加执行权限；旧 `closed-agent` 仅为当时 owner 私聊建立封闭策略。回退将路由标为停用，
保留审计并返回旧配置快照供运行适配层使用。owner 身份仍须服从当前可信配置，不能把
迁移快照里的旧 owner 号重新当作当前身份授权。

更改 owner 时撤销旧封闭策略，不自动授予新 owner；普通仿真策略与指纹保持不变。
由旧 owner 命令写入的保留策略重新标记为迁移来源，原操作者仍保留在审计的 before 中。
接口返回的审计事件与已落盘事件一致，单会话修改只返回该会话的 `changedKeys`。

## 操作者与 HTTP 模块

`policyOperator()` 仅接受可信适配层在完成鉴权后生成的上下文：已认证控制台，或由 QQ
事件确认的 owner 本人私聊。群里的 owner 消息、其他私聊、会话 agent、未鉴权请求都不能
修改策略。请求体中的 `updatedBy` 不作为身份；实际保存值由适配层身份派生。

`src/http/conversation-routes.js` 已注册以下管理接口：

| 请求 | 用途 |
| --- | --- |
| `GET /api/conversations` | 查看启用状态、存储告警、策略与审计 |
| `POST /api/conversations/migrate` | 根据运行时可信旧配置迁移；不接受请求体重定义 mode/owner |
| `POST /api/conversations/policy` | 保存 `{key, policy}`；preset 须已由 DSH 加载 |
| `DELETE /api/conversations/policy?key=...` | 删除覆盖，回到安全默认值 |
| `POST /api/conversations/rollback` | 停用逐会话路由，保留审计 |

HTTP 处理模块额外拒绝所有带 agent 标记/令牌的请求，授权白名单也拒绝这些新路径。
鉴权上下文必须来自现有控制台鉴权结果，绝不能将请求 JSON 的 auth 字段直接传入。
若保存已成功但运行时应用失败，响应明确给出 `committed: true`、`requiresRestart: true`；
不能谎报未保存，或让操作者无意中重复提交。写失败则不调用运行时更新回调。

## 控制台与运行行为

控制台「运行总览 → 逐会话模式」提供迁移、会话编辑、恢复默认策略、变更记录和回退。
启用后旧全局模式按钮停用；恢复默认会删除单会话覆盖，回到安全仿真默认策略。
回退仅停用逐会话路由，原全局配置继续生效，不把迁移时记录的旧 owner 重新授权。
角色页面的仿真提示词编辑器可分别编辑四套仿真 preset；请按会话实际使用的 preset 选择，
保存其中一套不会修改其他套，仍需重启 DSH 加载。

入站解析后、投递前、实际发送前、事件回复和定时唤醒均按会话检查策略。带会话令牌的
HTTP 请求根据令牌所属会话查询模式；不能借 owner 的全局/私聊模式跨到其他会话。
仿真内部文本保持不自动转发，owner 私聊仍正常收到回复。暂停/关闭二代活动不阻止
owner 操作会话的输入和回复。旧一代会话覆盖保持对应协议，不在加载时只改 mode 而留下
不匹配的 preset。

单会话更新只退役策略指纹变化的映射、令牌和待投递任务，不重新安排其他会话的定时器；
只有变更元数据时不会重建会话。单会话重置不使其他在途创建失效，二代状态重置也不删除
owner 操作映射。owner 变更立即撤销旧私聊的执行权限；同步保存失败时拒绝继续修改策略。

模型 ID 与思考强度可以逐会话覆盖，留空跟随全局配置；模型所属 provider 仍跟随全局
`dsh.provider`。保存时验证实际目录支持，投递前再次应用；显式模型/强度失效时拒绝投递，
不会静默使用默认模型。`session.selectModel` 仍可能影响 DSH 全局默认，详见控制台既有提示。

验证入口：`npm run test:routing`，以及 `npm run test:console-ui`。真实 HTTP、事件流、
模型选择、迁移回退、跨会话隔离和重新加载均有接线回归。断线回复使用独立的持久化交付
日志，发送前复核逐会话策略。恢复行为和实测结果见 [执行记录](WORK_PLAN.md#第六批断线交付验收)。
