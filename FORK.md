# 二开说明（FORK）

本包是 [0QwQ0/dsh-ui-auth](https://github.com/0QwQ0/dsh-ui-auth) 的二开版本，在其认证网关与按用户隔离之上，
增加了**组（组 = 项目）**与**会话读写权限模型**。

## 上游基线

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/0QwQ0/dsh-ui-auth` |
| 上游版本 | `0.7.0` |
| 上游提交 | `99fa733427ad5acde717f6ce3f82f009e4bd467e`（2026-09-30） |
| DSH 兼容 | `>=0.2.0-rc.2 <0.3.0`（与上游一致） |

> ⚠️ 本包与上游 `dsh-ui-auth` **不可同时安装**：两者注册同一个 `uiAuth` 服务与同名插件行，
> 会触发 cordis 的 `service "uiAuth" has been registered` 冲突。装本包前先移除上游包。

## 权限模型（本次二开的目标）

| 动作 | 会话归属人 | 同组成员 | 其他用户 | 管理员 |
|---|---|---|---|---|
| 读会话（列表 / 历史 / 跟随 / 文件预览 / 事件帧） | ✅ | ✅ | ❌ | ✅ |
| 写会话（prompt / cancel / rename / fork / 排队 / 附件 / 切模型 / 作答 / 目标 / 上传） | ✅ | ❌ | ❌ | **❌（只读）** |
| 建会话 / 工作区增删改 | ✅ | ❌ | ❌ | ✅（部署级能力保持上游不变） |
| 按用户浏览会话（面板：用户 → 会话 → 只读转录） | — | — | — | ✅ |
| 组的增删改查与成员分配 | — | — | — | ✅（唯一入口） |
| 查看自己所在的组 | ✅ | — | — | ✅ |
| 读自己的会话转录 | ✅ | — | — | — |

- **组**：一个用户可属于多个组；一个组多名成员；组名唯一。
- **成员只能由管理员分配**：组的所有写操作都在 `/auth/rpc/{createGroup,renameGroup,setGroupMembers,removeGroup}`，
  全部经 `requireAdmin()` 门禁并写审计（`groupCreate` / `groupRename` / `groupMembers` / `groupRemove`）。
- **fail-closed**：组查询抛错、组文件损坏、fs 服务缺席时，一律视为「无组关系」——
  组内共享不生效，绝不退化成「全员可读」。

## 改动清单

上游文件内的改动共 781 行；另有新增文件与测试。

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/group-store.ts` | **新增**：组存储（原子落盘、防抖、损坏隔离、`shares()` 同步索引） | 295 行 |
| `src/session-transcript.ts` | **新增**：会话事件流 → 只读转录（纯函数：正文提取、标题折叠、按归属分组） | 213 行 |
| `src/modern-policy.ts` | 谓词拆分：`session`（读=本人+同组+管理员）/ `sessionWrite`（写=仅归属人）；`workspace` / `workspaceWrite`；`agent` / `agentWrite`；新增 `conversationWriteTarget()` 把「仅本人可写」提到**管理员直通之前**；`ModernPolicyOptions.sharesGroup` | 122 行 |
| `src/modern-gateway.ts` | `ModernAuth.sharesGroup?` 接口 + 传入 `createModernPolicy` | 15 行 |
| `src/index.ts` | 组存储实例/装载/flush；`storeRemove` 联动摘除成员；`sharesGroup` 接线；6 个组管理 RPC；**2 个会话浏览 RPC**（`adminSessionsByUser` / `adminSessionRead`）；标题 TTL 缓存；跨用户读取审计；模块级校验辅助 | 325 行 |
| `src/client.ts` | 设置面板「组（项目）」分区（管理员增删改查、普通用户只读）+「按用户浏览会话」分区（用户 → 会话 → 只读转录） | 319 行 |
| `test/group-store.test.mjs` | **新增**：存储与同组判定（9 例） | 137 行 |
| `test/group-policy.test.mjs` | **新增**：权限矩阵、投影、fail-closed（11 例） | 151 行 |
| `test/session-transcript.test.mjs` | **新增**：转录提取、标题折叠、分组、防御性（8 例） | 129 行 |

### 按用户浏览会话（管理员）

数据源是宿主 `ctx.get('sessionQuery')`（DSH `packages/session-query`）：

| 作用 | 宿主 API | 说明 |
|---|---|---|
| 枚举全部会话 | `listSessions()` | 返回 `{ header:{id,createdAt,cwd}, live, persisted }` |
| 取会话标题 | `readTitle(id)` | 标题是事件流里的 `session/title`，不在 header 上；带 60s TTL 缓存 + 200 条上限 + 并发 8 |
| 读会话内容 | `readSession(id)` | 返回完整事件流，由 `buildTranscript()` 投影成转录 |

转录只保留**真人输入**（`user/message` 且 `source.kind === 'user'`）与**助手正文**（`assistant/message` 的 `text` 块）；
思考块（`reasoning`）、工具调用、系统提示、审批与沙箱事件都不入转录。默认取最新 300 条、单条上限 8000 字符，
并在界面上如实报告丢弃/截断条数。跨用户读取会写审计（`sessionRead`）。

> 事件形状取自真实生产日志（`~/.dsh/sessions/.../session.v4.jsonl.zstd`）；`test/session-transcript.test.mjs`
> 的夹具与真实形状一致，另可用真实日志复跑提取器验证。

### 为什么改在谓词层

`modern-policy.ts` 里全部投影函数（`ownMap` / `workspaceValue` / `workspaceBaseline` / `result` / `frame`）
都调用同一组闭包谓词。因此把「读」谓词变成组感知后，**会话列表、工作区视图、事件帧过滤会自动继承组语义**，
无需逐处改造——这也是选择二开而非伴生插件的原因（`uiAuth.registerPolicy()` 的 `stream.project`
是**替换**而非组合，用它实现同样效果需要重写半个策略文件）。

## 跟随上游更新

1. `git clone https://github.com/0QwQ0/dsh-ui-auth` 取目标版本；
2. 把本包 `src/` 的四处改动按下列锚点重放：
   - `modern-policy.ts`：`ModernPolicyOptions` 加 `sharesGroup`；谓词块（`const session = ...`）拆读/写；
     `authorize()` 开头插「写前置校验」；各端点按读/写谓词替换；
   - `modern-gateway.ts`：`ModernAuth` 加 `sharesGroup?`；`createModernPolicy(auth, {...})` 传入；
   - `index.ts`：`GroupStore` 实例 + `groups.load()` + `groups.flush()` + `storeRemove` 联动 + `sharesGroup` 接线 + 组 RPC 分支；
   - `client.ts`：`GroupsPage` + `settings.section` 注册（`id: 'auth-groups'`, `order: 32`）。
3. `npm test` 必须全绿：上游 145 项安全断言 + `modern-policy` 19 例 + 本包新增 20 例。

上游未接线组功能时（`sharesGroup` 缺省）行为与上游**逐字节一致**，这条由
`test/group-policy.test.mjs` 的「未接线组功能时行为与上游一致」用例固化。

## 命名差异

插件名/包名/行 id 由 `dsh-ui-auth` 统一改为 `dsh-ui-auth-groups`（含 cookie 名、状态文件名、日志前缀），
以便与上游共存排查、并避免行 id 冲突。服务名 `uiAuth` 保持不变——下游插件接口契约不受影响。
