# 二开说明（FORK）

本包是 [0QwQ0/dsh-ui-auth](https://github.com/0QwQ0/dsh-ui-auth) 的二开版本，在其认证网关与按用户隔离之上，
增加了**组（组 = 项目）**、**私有空间 / 组工作区**与**会话读写权限模型**。

## 上游基线

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/0QwQ0/dsh-ui-auth` |
| 上游版本 | `0.7.0` |
| 上游提交 | `99fa733427ad5acde717f6ce3f82f009e4bd467e`（2026-09-30） |
| DSH 兼容 | `>=0.2.0-rc.2 <0.3.0`（与上游一致） |

> ⚠️ 本包与上游 `dsh-ui-auth` **不可同时安装**：两者注册同一个 `uiAuth` 服务与同名插件行，
> 会触发 cordis 的 `service "uiAuth" has been registered` 冲突。装本包前先移除上游包。

## 空间模型：无组 = 私有，组 = 项目空间

可见性只由**对象自己绑定了哪个组**决定，不再由「两人是否同组」决定：

| 对象 | 绑定情况 | 谁能读 | 谁能写 |
|---|---|---|---|
| 私有空间（工作区） | 未绑定组 | 归属人 + 管理员 | 归属人（管理员可读、可管理） |
| 组工作区（工作区） | 绑定组 G | G 的成员 + 管理员 | 归属人 + 管理员；**G 的成员可在其中建会话** |
| 私有会话 | 未绑定组 | 归属人 + 管理员 | 归属人 |
| 组会话 | 绑定组 G | G 的成员 + 管理员 | 归属人 |

- **每个人的私有空间**：登录后自动供给 `<私有空间根目录>/users/<用户名>`（幂等；已供给过则零 IO）。
  用户名含不安全字符时目录名追加 `-<8 位哈希>`（`..`、空格等不同用户名不会撞进同一目录）。
  在私有空间里建的会话**没有组绑定**，因此只有本人与管理员能看。
- **每个组的组工作区**：管理员在「组（项目）」面板里点「创建组工作区」，目录为
  `<私有空间根目录>/groups/<组名>-<组 id 前 8 位>`；也可以把已有的部署工作区**绑定**给某个组。
- **会话在工作区里建，就继承该工作区的组，并在创建时冻结**（`sessionGroups` / `sessionWorkspaces`）：
  之后工作区改绑不会追溯改变已有会话的可见性；`session/fork` 继承源会话的绑定。
- **一个组至多一个组工作区**：改绑会先摘掉该组原来的工作区；管理员删组时，该组的工作区与会话
  **一起解绑**（退回私有），绝不留给别的组。

## 权限模型

| 动作 | 会话归属人 | 同组成员（对象绑定了该组） | 其他用户 | 管理员 |
|---|---|---|---|---|
| 读对象所属组的会话/工作区（列表 / 历史 / 跟随 / 文件预览 / 事件帧 / 导出） | ✅ | ✅ | ❌ | ✅ |
| 读私有会话/私有空间（无组绑定） | ✅ | **❌** | ❌ | ✅ |
| 写会话（prompt / cancel / rename / fork / 排队 / 附件 / 切模型 / 作答 / 目标 / 上传 / 反馈） | ✅ | ❌ | ❌ | **❌（只读）** |
| 在组工作区里建会话 | ✅ | ✅ | ❌ | ✅ |
| 在他人私有空间里建会话 | — | — | ❌ | ✅（部署级能力） |
| 工作区改名 / 删除 / 工作区级排序 | ✅ | ❌ | ❌ | ✅ |
| 会话级排序（自己会话在组工作区里的位置） | ✅ | ✅（自己的会话） | ❌ | ✅ |
| 按用户浏览会话（面板：用户 → 会话 → 只读转录） | — | — | — | ✅ |
| 组的增删改查、成员分配、组工作区绑定 | — | — | — | ✅（唯一入口） |
| 查看自己所在的组与自己的私有空间 | ✅ | — | — | ✅ |

- **组**：一个用户可属于多个组；一个组多名成员；组名唯一。组本身只描述成员关系，
  「对象属于哪个组」写在归属表里。
- **成员只能由管理员分配**：组的所有写操作都在 `/auth/rpc/*`，全部经 `requireAdmin()` 门禁并写审计
  （`groupCreate` / `groupRename` / `groupMembers` / `groupRemove` / `groupWorkspaceCreate` /
  `groupWorkspaceBind` / `groupWorkspaceUnbind` / `privateWorkspaceCreate` / `workspaceProvision`）。
- **fail-closed**：组查询抛错、组文件损坏、fs 服务缺席、`workspaceRegistry` 缺席时，一律视为
  「无组绑定」——对象退回**私有**，绝不退化成「组内可读」或「全员可读」。
- **存量数据**：v1 归属表（只有 `sessions` / `workspaces`）可直接升级；没有组绑定的历史会话/工作区
  一律按**私有**处理（这正是上游语义），不会有任何对象因为升级而变宽。

## 配置

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `DSH_AUTH_WORKSPACES_DIR` | `<DSH_HOME>/spaces`（`DSH_HOME` 缺省为 `~/.dsh`） | 私有空间与组工作区的根目录 |
| `DSH_AUTH_PROVISION` | 开 | `0` / `false` / `off` / `no` 关闭登录时的自动供给（管理员仍可显式创建） |
| `DSH_HOME` | `~/.dsh` | 未显式指定根目录时的父目录 |

登录时的供给**不阻塞登录**：已供给过的用户走内存命中；首次供给最多等 800ms，超时即放行、
供给继续在后台完成（失败只记日志，面板里还有「创建私有空间」按钮可重试）。

## 改动清单

上游文件内的改动共 1,313 行新增 / 94 行删除（客户端含面板重写）；另有 4 个新增源文件与 5 个新增测试文件。

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/spaces.ts` | **新增**：私有空间/组工作区的目录推导（路径穿越防护）与供给（`workspaceRegistry` + mkdir + 归属登记），全部依赖可注入 | 216 行 |
| `src/group-store.ts` | **新增**：组存储（原子落盘、防抖、损坏隔离、`isMember()` 同步索引） | 300 行 |
| `src/session-transcript.ts` | **新增**：会话事件流 → 只读转录（纯函数：正文提取、标题折叠、按归属分组 + 组/工作区标注） | 226 行 |
| `src/modern-policy.ts` | 谓词按「对象所属组」判定：`session` / `workspace` 读谓词 + `sessionWrite` / `workspaceWrite` / `workspaceManage` 分离；`conversationWriteTarget()` 把「仅本人可写」提到**管理员直通之前**；`result(..., payload)` 在建会话/fork 时冻结工作区与组绑定 | 180 行 |
| `src/modern-gateway.ts` | `ModernAuth` 增加组查询/绑定接缝；`policy.result` 传入请求 payload；直连路由拆分：`/api/session.export` 用策略**读**谓词（组内可读），`/api/session/uploadFileBinary` 仍是**仅归属人**（组内可读 ≠ 可写） | 16 行 |
| `src/index.ts` | 归属表 v2（组绑定/私有空间）+ 串行化写入与回滚；空间供给接线；登录/注册时供给；6 个组 RPC + **6 个工作区/空间 RPC**；**2 个会话浏览 RPC**；标题 TTL 缓存；审计 | 677 行 |
| `src/client.ts` | 设置面板「组（项目）」分区（管理员 CRUD + 组工作区绑定/创建/解绑、私有空间卡片）+「按用户浏览会话」分区（组标签与组筛选） | 430 行 |
| `test/spaces.test.mjs` | **新增**：目录清洗/去重/穿越防护、幂等供给、宿主缺席 fail-closed（13 例） | 218 行 |
| `test/group-store.test.mjs` | **新增**：存储与成员判定（9 例） | 146 行 |
| `test/group-policy.test.mjs` | **新增**：权限矩阵、建会话落点、投影、绑定冻结、fail-closed（16 例） | 247 行 |
| `test/session-transcript.test.mjs` | **新增**：转录提取、标题折叠、分组、防御性（8 例） | 129 行 |

### 宿主接缝

| 接缝 | 用途 |
|---|---|
| `ctx.workspaceRegistry.create(path, title)` | 登记私有空间/组工作区（DSH 侧栏读的就是它）；按 canonical path 去重 |
| `ctx.get('fs')` | 组表落盘（与上游一致） |
| `ctx.get('sessionQuery')` | 管理员「按用户浏览会话」：`listSessions()` / `readTitle(id)` / `readSession(id)` |
| `credentials` 记录 `dsh-auth/ownership` | 归属表 v2：`sessions` / `workspaces` / `workspaceGroups` / `sessionGroups` / `sessionWorkspaces` / `privateWorkspaces` |

### 按用户浏览会话（管理员）

| 作用 | 宿主 API | 说明 |
|---|---|---|
| 枚举全部会话 | `listSessions()` | 返回 `{ header:{id,createdAt,cwd}, live, persisted }` |
| 取会话标题 | `readTitle(id)` | 标题是事件流里的 `session/title`，不在 header 上；带 60s TTL 缓存 + 200 条上限 + 并发 8 |
| 读会话内容 | `readSession(id)` | 返回完整事件流，由 `buildTranscript()` 投影成转录 |

列表里每条会话带 `group` / `groupId` / `workspaceId`，面板支持按组筛选（含「私有（无组）」）。
转录只保留**真人输入**（`user/message` 且 `source.kind === 'user'`）与**助手正文**（`assistant/message` 的 `text` 块）；
思考块（`reasoning`）、工具调用、系统提示、审批与沙箱事件都不入转录。默认取最新 300 条、单条上限 8000 字符，
并在界面上如实报告丢弃/截断条数。跨用户读取会写审计（`sessionRead`，带组信息）。

> 事件形状取自真实生产日志（`~/.dsh/sessions/.../session.v4.jsonl.zstd`）；`test/session-transcript.test.mjs`
> 的夹具与真实形状一致，另可用真实日志复跑提取器验证。

### 为什么改在谓词层

`modern-policy.ts` 里全部投影函数（`ownMap` / `workspaceValue` / `workspaceBaseline` / `result` / `frame`）
都调用同一组闭包谓词。因此把「读」谓词变成**组绑定感知**后，**会话列表、工作区视图、事件帧过滤会自动继承组语义**，
无需逐处改造——这也是选择二开而非伴生插件的原因（`uiAuth.registerPolicy()` 的 `stream.project`
是**替换**而非组合，用它实现同样效果需要重写半个策略文件）。

## 跟随上游更新

1. `git clone https://github.com/0QwQ0/dsh-ui-auth` 取目标版本；
2. 把本包 `src/` 的改动按下列锚点重放：
   - `modern-policy.ts`：`OwnershipLookup` 增加 `sessionGroup` / `sessionWorkspace` / `workspaceGroup` /
     `isMember` / `bindSession`；谓词块（`const session = ...`）拆读/写/管理；`result()` 增加 `payload` 参数
     并在建会话/fork 时调 `bindSession`；`authorize()` 开头插「写前置校验」；各端点按读/写/管理谓词替换；
   - `modern-gateway.ts`：`ModernAuth` 增加组查询接缝；`policy.result(...)` 传入 `envelope.payload`；
     `ownsQuerySession()` 改用 `policy.session()`；
   - `index.ts`：归属表 v2 + `mutateOwnership()` 串行写入；`SpaceProvisioner` 接线；登录/注册后供给；
     组 RPC 分支；工作区/空间 RPC 分支；`groups.load()` / `groups.flush()` / `storeRemove` 联动；
   - `client.ts`：`GroupsPage` + `SessionsByUserPage` + `settings.section` 注册
     （`id: 'auth-groups'`, `order: 32`；`id: 'auth-sessions'`, `order: 33`）。
3. `npm test` 必须全绿：上游 145 项安全断言 + `modern-policy` 19 例 + 本包新增 46 例
   （spaces 13 / group-store 9 / group-policy 16 / session-transcript 8）+ 宿主集成 161 项。

未接线组功能时（组表为空、归属表里没有任何组绑定）行为与上游一致：一切都是私有的，
这条由 `test/group-policy.test.mjs` 的「未接线组功能时行为与上游一致」用例固化。

## 命名差异

插件名/包名/行 id 由 `dsh-ui-auth` 统一改为 `dsh-ui-auth-groups`（含 cookie 名、状态文件名、日志前缀），
以便与上游共存排查、并避免行 id 冲突。服务名 `uiAuth` 保持不变——下游插件接口契约不受影响。
