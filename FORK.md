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
| `DSH_AUTH_CONFINE_FILES` | 开 | `0` / `false` / `off` / `no` 关闭「工作区文件读取收敛」（普通用户将可读进程可读的任意文件，仅在对内全信任的部署里才应关闭） |
| `DSH_HOME` | `~/.dsh` | 未显式指定根目录时的父目录 |

登录时的供给**不阻塞登录**：已供给过的用户走内存命中；首次供给最多等 800ms，超时即放行、
供给继续在后台完成（失败只记日志，面板里还有「创建私有空间」按钮可重试）。

## 改动清单

上游文件内的改动共 1,469 行新增 / 100 行删除（客户端含面板重写）；另有 4 个新增源文件与 5 个新增测试文件。

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/spaces.ts` | **新增**：私有空间/组工作区的目录推导（路径穿越 + 目录名去重）与供给（`workspaceRegistry` + mkdir + 归属登记），以及文件读取收敛用的 `confinePath()`；依赖全部可注入 | 272 行 |
| `src/group-store.ts` | **新增**：组存储（原子落盘、防抖、损坏隔离、`isMember()` 同步索引） | 300 行 |
| `src/session-transcript.ts` | **新增**：会话事件流 → 只读转录（纯函数：正文提取、标题折叠、按归属分组 + 组/工作区标注） | 226 行 |
| `src/modern-policy.ts` | 谓词按「对象所属组」判定：`session` / `workspace` 读谓词 + `sessionWrite` / `workspaceWrite` / `workspaceManage` 分离；`conversationWriteTarget()` 把「仅本人可写」提到**管理员直通之前**；`result(..., payload)` 在建会话/fork 时冻结工作区与组绑定；`confinePaths` 对工作区文件读取做路径收敛 | 224 行 |
| `src/modern-gateway.ts` | `ModernAuth` 增加组查询/绑定/收敛接缝；`policy.result` 传入请求 payload；直连路由拆分：`/api/session.export` 用策略**读**谓词（组内可读），`/api/session/uploadFileBinary` 仍是**仅归属人**（组内可读 ≠ 可写）；query 上的 `sessionId` 重复参数一律拒绝（宿主 `Object.fromEntries` 取最后一个，与 `get()` 分叉）；`session/create` 带他人 id 时合成宿主同款 `session/writer-held` | 84 行 |
| `src/index.ts` | 归属表 v2（组绑定/私有空间）+ 串行化写入与回滚；空间供给接线；登录/注册时供给；6 个组 RPC + **6 个工作区/空间 RPC**；**2 个会话浏览 RPC**；文件读取收敛接线（`confinePaths`）；`sessionExists` 同时支持 0.2.0 的 `stat` 与旧 `inspect`；标题 TTL 缓存；审计 | 697 行 |
| `src/client.ts` | 设置面板「组（项目）」分区（管理员 CRUD + 组工作区绑定/创建/解绑、私有空间卡片）+「按用户浏览会话」分区（组标签与组筛选） | 430 行 |
| `test/spaces.test.mjs` | **新增**：目录清洗/去重/穿越防护、`confinePath` 收敛、幂等供给、宿主缺席 fail-closed（14 例） | 250 行 |
| `test/group-store.test.mjs` | **新增**：存储与成员判定（9 例） | 146 行 |
| `test/group-policy.test.mjs` | **新增**：权限矩阵、建会话落点、投影、绑定冻结、文件读取收敛、fail-closed（17 例） | 290 行 |
| `test/session-transcript.test.mjs` | **新增**：转录提取、标题折叠、分组、防御性（8 例） | 129 行 |

### 安全加固：工作区文件读取收敛（0.8.0）

宿主 `workspaceFiles/read|readBytes|stat` 的文档写着 "absolute path … files outside it are allowed"，
只有 `list` 会做包含性校验：**任何登录用户只要有一个可读会话，就能读到 DSH 进程可读的任意文件**
（`~/.dsh/.credentials.yaml` 里的全部口令哈希、TOTP 密钥与归属表，别人的私有空间与会话日志……
——这会让「私有空间」名存实亡）。本 fork 因此在策略层补上收敛：

- 普通用户的每次 `workspaceFiles/{read,readBytes,stat,list,changes}` 与 `officeToPdf/*`
  都必须证明「目标路径落在**该会话自己的工作区**内」（`confinePath()`：绝对/相对路径、
  `baseFile` 相对解析、`..` 折叠、同前缀兄弟目录、Windows 大小写都按平台规则处理）；
  判不出来（会话没有工作区记录、宿主注册表缺席、回调抛错）一律拒绝；
- 管理员不受此限制（部署级能力保持上游不变）；
- `DSH_AUTH_CONFINE_FILES=0` 可关闭（默认开启）；
- **残余**：工作区内的**符号链接**指向外部时仍会被读到（宿主 `fs.resolve` 会跟随）。
  要彻底堵住需要宿主在 `locateFile` 里改用 `fs.contains`（已在上游反馈过的方向）。

### 建会话：客户端自带 id（reuseBlank）

DSH 客户端点开一个工作区时会先找该工作区里的**空白会话**复用，命中就带 id 调
`session/create {workspaceId, sessionId}`（`ui-workspace/navigation.ts` 的 `reuseBlank`），
只有宿主回 `session/writer-held` 时才降级成「不带 id 新建」。这条路径有两个坑：

- **`sessionExists` 必须认 0.2.0 的 `sessionPersistence.stat`**：0.2.0 的持久化服务是
  `stat(id)`（不存在时返回 `undefined`），没有 `inspect`。原来只认 `inspect`，取不到就
  fail-closed 返回「存在」→ **任何自带 id 的建会话都被判成已存在而 403**，
  表现就是「成员在组工作区里点开会话直接被拒绝」。现在两种宿主 API 都支持。
- **别人的会话要回宿主同款错误码**：策略层先于宿主拦下请求，因此必须自己回一个
  `session/writer-held` 失败信封（HTTP 200 + `result.ok=false`），客户端才会自动改用新会话重试；
  否则界面直接报错。只对「调用者本来就能读」的会话这么做（不可见的会话保持纯 403，不做存在性预言机），
  并且**绝不把请求转发给宿主** —— 冷会话会被宿主 resume 并把写权限交出去。

### 直连路由的两个坑

- `/api/session.export?sessionId=…`：宿主用 `Object.fromEntries(url.searchParams)` 取值
  （**重复参数取最后一个**），而网关的 `get()` 取第一个 —— 两边分叉就能「检查 A 的会话、导出 B 的会话」。
  现在 query 上的 `sessionId` 重复出现即拒绝。
- `/api/session/uploadFileBinary`：上传是**写**面（把字节挂在指定会话下），因此判定与
  `fileUploads/upload` 一致 —— 仅归属人本人，管理员对他人会话同样只读。

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
   - `modern-gateway.ts`：`ModernAuth` 增加组查询/收敛接缝；`policy.result(...)` 传入 `envelope.payload`；
     `ownsQuerySession()` 改用 `policy.session()`；query `sessionId` 重复参数拒绝；
   - `index.ts`：归属表 v2 + `mutateOwnership()` 串行写入；`SpaceProvisioner` 接线；
     `confinePaths` 接线（`sessionWorkspaces` → 注册表路径 → `confinePath`）；登录/注册后供给；
     组 RPC 分支；工作区/空间 RPC 分支；`groups.load()` / `groups.flush()` / `storeRemove` 联动；
   - `client.ts`：`GroupsPage` + `SessionsByUserPage` + `settings.section` 注册
     （`id: 'auth-groups'`, `order: 32`；`id: 'auth-sessions'`, `order: 33`）。
3. `npm test` 必须全绿：上游 145 项安全断言 + `modern-policy` 19 例 + 本包新增 48 例
   （spaces 14 / group-store 9 / group-policy 17 / session-transcript 8）+ 宿主集成 175 项。

未接线组功能时（组表为空、归属表里没有任何组绑定）行为与上游一致：一切都是私有的，
这条由 `test/group-policy.test.mjs` 的「未接线组功能时行为与上游一致」用例固化。

## 命名差异

插件名/包名/行 id 由 `dsh-ui-auth` 统一改为 `dsh-ui-auth-groups`（含 cookie 名、状态文件名、日志前缀），
以便与上游共存排查、并避免行 id 冲突。服务名 `uiAuth` 保持不变——下游插件接口契约不受影响。
