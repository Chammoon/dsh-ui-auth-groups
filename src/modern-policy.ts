/**
 * DSH 0.1.5 Remote surface policy — reviewed by endpoint, ordinary users fail closed.
 *
 * Source of truth for the reviewed surface: DSH `dsh-v0.1.5-rc.1`
 * (`packages/api/*` `@Remote` descriptors, `packages/api/remotes/src/remote-events.ts`).
 * Unknown endpoints and unknown events are denied; ownership comes from the
 * plugin's own attribution table (`owners`), never from client-supplied fields.
 *
 * Wire conventions this module encodes:
 * - unary args are `payload.args`; most methods nest one `request` object, flat
 *   methods (`settings/*`, `credentials/*`, `workspaceFiles/*`, `llm/*`, `*Id`
 *   scoped verbs) carry their fields directly;
 * - `session/list` is the one method whose wire field is `_request`;
 * - `session/page` / `session/follow` address sessions durably
 *   (`{ kind: 'session' | 'subagent', sessionId, parentSessionId?, childSessionId? }`);
 * - agent-scoped verbs carry `agentId`, a SessionId;
 * - `workspaceFiles/*` carry `workspaceFileScopeId`, also a SessionId.
 *
 * Baseline note: this module is the only policy path. v0.7.0 removed the legacy
 * dotted/`apiProxy` transport, so a host without `connection.authorizeIndex`
 * (DSH 0.1.1-rc.2) is refused at startup instead of falling back.
 */

/** One authenticated principal; `role` is `'admin'` for administrators. */
export interface Principal {
  readonly username: string
  readonly role: string
}

/** Ownership queries and attribution used by the policy (supplied by `index.ts`). */
export interface OwnershipLookup {
  /** 会话归属人用户名（未登记为 `'admin'`）。 */
  session(id: string): string
  /** 工作区归属人用户名（未登记为 `'admin'`）。 */
  workspace(id: string): string
  /** 会话冻结的组绑定（`undefined` = 私有会话）。 */
  sessionGroup(id: string): string | undefined
  /** 会话创建时所在的工作区（用于 fork 继承与管理员视图）。 */
  sessionWorkspace(id: string): string | undefined
  /** 工作区绑定的组（`undefined` = 私有工作区）。 */
  workspaceGroup(id: string): string | undefined
  /** 成员关系查询：`username` 是否属于 `groupId`（同步、fail-closed）。 */
  isMember(username: string, groupId: string): boolean
  sessionExists(id: string): Promise<boolean>
  claimSession(id: string, username: string): Promise<void>
  /** 登记会话的工作区与组绑定（建会话 / fork 之后调用）。 */
  bindSession(id: string, workspaceId: string | undefined, groupId: string | undefined): Promise<void>
}

/** Any decoded JSON object. */
export type JsonObject = Record<string, unknown>

/** Per-stream correlation state: the delivered `clientId` plus pending waterfall ids. */
export interface StreamCorrelation {
  clientId?: string
  /** Login-token hash of the generation that owns this stream (set by the gateway). */
  login?: string
  events: Set<string>
}

export const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256

/** Own-session session methods addressed by `request.sessionId`. */
const SESSION_BY_ID = new Set(['prompt', 'attachment', 'cancel', 'rename', 'selectModel', 'updateQueue', 'fork'])
/** Own-workspace workspace methods addressed by `request.workspaceId`. */
const WORKSPACE_BY_ID = new Set(['rename', 'delete', 'insertBefore', 'insertSessionBefore'])
/** Read-only, owner-filtered session endpoints. */
const SESSION_READ = new Set(['list', 'search', 'modelCatalog', 'canOpenWorkspacePath'])
/** Flat read-only global metadata an ordinary user may see (redacted by the host). */
const SHARED_READ = new Set(['settings/describe', 'llm/listProviders', 'llm/listConfigurableProviders'])
/** Plugin-manager reads the settings page performs on load; its write verbs stay administrator-only. */
const PLUGIN_MANAGER_READ = new Set(['listPlugins', 'listBundles', 'registries', 'inspect'])
/** Interactive question endpoints: agent-scoped or session-scoped, both are ownership proofs. */
const SESSION_INTERACTIVE = new Set(['userQuestions/answer', 'userQuestions/attachWait'])
/** Office-to-PDF carries positional args `(workspaceFileScopeId, path, priority)`. */
const OFFICE_TO_PDF_SCOPE_INDEX = 0
/** …and the second positional arg is the target path. */
const OFFICE_TO_PDF_PATH_INDEX = 1

/** The raw `args` value of a Remote payload (an object, or a positional array). */
function rawArgs(payload: unknown): unknown {
  return object(payload) ? payload.args : undefined
}

/** The single `args` object of a Remote payload, or undefined when malformed. */
export function remoteArgs(payload: unknown): JsonObject | undefined {
  if (!object(payload) || Object.keys(payload).length !== 1 || !object(payload.args)) return undefined
  return payload.args
}

/** Normalize one endpoint's args into its request object (nested or flat). */
function requestOf(args: JsonObject): JsonObject {
  if (object(args.request)) return args.request
  return args
}

/**
 * 会话「写」端点的目标会话 id。
 *
 * 作用是把「仅本人可写」提前到**管理员直通之前**：管理员可以读他人会话，
 * 但写动作（prompt / cancel / rename / fork / updateQueue / attachment /
 * selectModel / 作答 / 反馈 / 目标 / 上传）同样只属于会话归属人。
 *
 * 只登记会改变会话内容或状态的动作；读面与部署级管理面（设置、凭据、插件、
 * 工作区增删改）不在其中，管理员的部署级能力保持上游不变。
 *
 * 解析不出目标 id 时返回 `undefined`，交常规规则判定 —— 缺少 id 的调用在宿主侧
 * 也无法定位会话，不构成绕过。
 */
function conversationWriteTarget(endpoint: string, args: JsonObject): string | undefined {
  const request = requestOf(args)
  const fromRequest = (): string | undefined => {
    const value = request.sessionId ?? args.sessionId
    return nonempty(value) ? value : undefined
  }
  const fromAgent = (): string | undefined => (nonempty(args.agentId) ? args.agentId : undefined)
  if (endpoint.startsWith('session/')) {
    return SESSION_BY_ID.has(endpoint.slice('session/'.length)) ? fromRequest() : undefined
  }
  if (endpoint === 'userQuestions/answer') return fromAgent() ?? fromRequest()
  if (endpoint === 'sessionFeedback/record') return fromRequest()
  if (endpoint.startsWith('messageFeedback/')) return fromRequest()
  if (endpoint === 'agentPresets/select') return fromAgent()
  if (endpoint === 'fileUploads/upload') return fromAgent()
  if (endpoint.startsWith('goals/')) return fromAgent()
  return undefined
}

export interface ModernPolicy {
  session(principal: Principal, id: unknown): boolean
  workspace(principal: Principal, id: unknown): boolean
  authorize(principal: Principal, endpoint: string, payload: unknown, stream?: boolean): Promise<boolean>
  /**
   * 响应侧投影。
   * @param payload - 同一请求的原始 wire payload；`session/create` / `session/fork`
   *   靠它把新会话绑定到工作区与组（响应体里没有 workspaceId）。
   */
  result(principal: Principal, endpoint: string, value: unknown, payload?: unknown): Promise<unknown>
  frame(principal: Principal, endpoint: string, value: unknown, correlation: StreamCorrelation): unknown
}

/** 普通用户可用的模型范围（R2：按登录用户裁剪 provider 列表与模型目录）。 */
export interface ModelEntitlement {
  /** 允许的 provider 路由 id（如 `deepseek`）。 */
  readonly providers: readonly string[]
  /** 允许的 provider + model 组合；provider 已在上表列出的，仍需逐模型登记。 */
  readonly models: readonly { readonly provider: string; readonly model: string }[]
}

export interface ModernPolicyOptions {
  /**
   * 按登录用户返回模型授权范围。返回 `undefined` 表示不裁剪（保持只读放行）；
   * 管理员从不受此限制。未提供该回调时行为与以前完全一致。
   */
  readonly entitlement?: (principal: Principal) => Promise<ModelEntitlement | undefined> | ModelEntitlement | undefined
  /**
   * 工作区文件读取的路径收敛（安全加固，0.8.0）：宿主 `workspaceFiles/read|readBytes|stat|list`
   * **不限制路径**（绝对路径可指向进程可读的任意文件），因此普通用户的每次读取都要在这里
   * 证明「目标在该会话的工作区内」。
   *
   * 未提供该回调时保持上游行为（管理员不受此限制）；回调抛错或返回非 true 一律拒绝。
   */
  readonly confinePaths?: (
    principal: Principal,
    sessionId: string,
    path: string,
    baseFile: string | undefined,
  ) => Promise<boolean> | boolean
}

/** provider 行/模型行的字段名在不同包里有 `id`/`provider`/`model` 等写法，这里做容错读取。 */
const rowId = (row: unknown): string | undefined => {
  if (!object(row)) return undefined
  for (const key of ['id', 'provider', 'providerId', 'name']) {
    const value = row[key]
    if (nonempty(value)) return value
  }
  return undefined
}
const rowModel = (row: unknown): string | undefined => {
  if (!object(row)) return undefined
  for (const key of ['id', 'model', 'modelId', 'name']) {
    const value = row[key]
    if (nonempty(value)) return value
  }
  return undefined
}

export function createModernPolicy(owners: OwnershipLookup, options: ModernPolicyOptions = {}): ModernPolicy {
  /** 取当前主体的授权范围（管理员永远不受限）。 */
  const entitlementOf = async (principal: Principal): Promise<ModelEntitlement | undefined> => {
    if (principal.role === 'admin' || options.entitlement === undefined) return undefined
    return await options.entitlement(principal)
  }
  const allowedProvider = (scope: ModelEntitlement, provider: unknown): boolean =>
    nonempty(provider) && scope.providers.includes(provider)
  const allowedModel = (scope: ModelEntitlement, provider: unknown, model: unknown): boolean =>
    nonempty(provider) && nonempty(model)
    && scope.models.some(entry => entry.provider === provider && entry.model === model)
  const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  /**
   * 组成员判定：`username` 是否属于 `groupId`。
   * fail-closed —— 未接线、id 非法或查询抛错一律视为不是成员。
   */
  const member = (username: string, groupId: unknown): boolean => {
    if (!nonempty(username) || !nonempty(groupId)) return false
    try {
      return owners.isMember(username, groupId) === true
    } catch {
      return false
    }
  }
  /**
   * 组绑定查询（fail-closed）：未接线、形状不对或查询抛错一律视为**无绑定 = 私有**。
   * 组存储故障绝不能退化成「组内可读」。
   */
  const binding = (lookup: (id: string) => string | undefined, id: string): string | undefined => {
    try {
      const value = lookup(id)
      return nonempty(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  /**
   * 可见性核心：管理员 ‖ 归属人本人 ‖ 对象绑定到查看者所在的组。
   *
   * 注意这里**没有**「同组即可读」的兜底：一个没有组绑定的对象对组友不可见。
   * 这正是「无组 = 私有」的实现点 —— 私有空间里的会话只属于本人与管理员。
   */
  const visible = (principal: Principal, owner: string, groupId: string | undefined): boolean =>
    principal.role === 'admin' || owner === principal.username || member(principal.username, groupId)
  /**
   * 会话「读」谓词：绑定组 → 组内成员可读；无组 → 仅本人 + 管理员。
   *
   * 全部列表/工作区/事件帧投影都调用它，因此组会话会自动出现在会话列表、
   * 工作区视图与实时事件流里，无需逐处改造。
   */
  const session = (principal: Principal, id: unknown): boolean =>
    nonempty(id) && visible(principal, owners.session(id), binding(owners.sessionGroup, id))
  /**
   * 会话「写」谓词：仅归属人本人。
   *
   * 管理员对他人会话同样只读 —— 这正是需求里的「仅本人可写，组内其他人可读，
   * 管理员可读」。用于 prompt / cancel / rename / fork / updateQueue /
   * attachment / selectModel 等一切会改变会话的动作。
   */
  const sessionWrite = (principal: Principal, id: unknown): boolean =>
    nonempty(id) && owners.session(id) === principal.username
  /**
   * 工作区「读」谓词：绑定组 → 组内成员可见（组会话因此能在侧栏被发现）；
   * 无组 → 私有，仅本人 + 管理员。
   */
  const workspace = (principal: Principal, id: unknown): boolean =>
    nonempty(id) && visible(principal, owners.workspace(id), binding(owners.workspaceGroup, id))
  /**
   * 工作区「管理」谓词：归属人 + 管理员（改名 / 删除 / 排序）。
   *
   * 组工作区由部署方供给、组员只是借用（建会话），所以他们不能改名或删除别人的项目目录。
   */
  const workspaceManage = (principal: Principal, id: unknown): boolean =>
    nonempty(id) && (principal.role === 'admin' || owners.workspace(id) === principal.username)
  /**
   * 工作区「写」谓词：管理权 + **组工作区的组内成员**。
   *
   * 组工作区是项目空间，组员必须能在里面建会话（`session/create` 校验的就是它）；
   * 会话内容仍是各写各的（{@link sessionWrite}）。
   */
  const workspaceWrite = (principal: Principal, id: unknown): boolean =>
    nonempty(id) && (workspaceManage(principal, id) || member(principal.username, binding(owners.workspaceGroup, id)))
  const ownMap = (principal: Principal, value: unknown): JsonObject =>
    Object.fromEntries(Object.entries(object(value) ? value : {}).filter(([id]) => session(principal, id)))
  const workspaceValue = (principal: Principal, value: JsonObject): JsonObject => ({
    ...value,
    sessionIds: arrayOf(value.sessionIds).filter(id => session(principal, id)),
  })
  const workspaceBaseline = (principal: Principal, value: unknown): JsonObject => {
    const baseline = object(value) ? value : {}
    return {
      items: arrayOf(baseline.items).filter(item => workspace(principal, object(item) ? item.workspaceId : undefined))
        .map(item => workspaceValue(principal, item as JsonObject)),
      archivedSessionIds: arrayOf(baseline.archivedSessionIds).filter(id => session(principal, id)),
    }
  }
  /** Agent-scoped 只读面（文件引用/命令清单/预设读取）按会话读谓词授权。 */
  const agent = (principal: Principal, args: JsonObject): boolean => session(principal, args.agentId)
  /** Agent-scoped 写动作（上传/目标/作答/选预设）按会话写谓词授权。 */
  const agentWrite = (principal: Principal, args: JsonObject): boolean => sessionWrite(principal, args.agentId)

  function authorizeSession(args: JsonObject, principal: Principal): boolean {
    const request = requestOf(args)
    if (request.address !== undefined) {
      const address = request.address
      if (!object(address)) return false
      if (address.kind === 'session') return session(principal, address.sessionId)
      // The Session Controller verifies the child's durable parent and mode before opening it.
      if (address.kind === 'subagent') return session(principal, address.parentSessionId) && nonempty(address.childSessionId)
      return false
    }
    return session(principal, request.sessionId)
  }

  /**
   * 工作区文件读取的路径判定：管理员放行；其余人必须有可判定的、落在会话工作区内的路径。
   *
   * fail-closed：路径缺失、scope 缺失、回调缺席以外的任何不确定情形都返回 false。
   */
  const pathAllowed = async (principal: Principal, scope: unknown, path: unknown, baseFile?: unknown): Promise<boolean> => {
    if (principal.role === 'admin') return true
    // 未接线：保持上游行为（路径由部署方自己把关，本模块不额外判定）。
    if (options.confinePaths === undefined) return true
    // 接线后（本仓库的默认部署）：必须是「可判定的、会话内的路径」，缺一不可。
    if (!nonempty(scope) || !nonempty(path)) return false
    try {
      return (await options.confinePaths(principal, scope, path, nonempty(baseFile) ? baseFile : undefined)) === true
    } catch {
      return false
    }
  }

  /**
   * 从建会话请求推出新会话的绑定（工作区 + 组）。
   *
   * - `session/create`：工作区由客户端指定（策略层已按可写性校验过），组绑定取该工作区的绑定；
   * - `session/fork`：继承源会话的工作区与组 —— 请求体与响应体都不带工作区信息。
   *
   * 解析不出时返回空绑定（= 私有），绝不猜测：宁可退回私有，也不默认共享。
   */
  function sessionBinding(endpoint: string, payload: unknown): { workspaceId?: string; groupId?: string } {
    const args = payload === undefined ? undefined : remoteArgs(payload)
    const request = args === undefined ? undefined : requestOf(args)
    if (endpoint === 'session/create') {
      const raw = request?.workspaceId
      const workspaceId = nonempty(raw) ? raw : undefined
      return { workspaceId, groupId: workspaceId === undefined ? undefined : binding(owners.workspaceGroup, workspaceId) }
    }
    const rawSource = request?.sessionId
    const source = nonempty(rawSource) ? rawSource : undefined
    if (source === undefined) return {}
    return { workspaceId: binding(owners.sessionWorkspace, source), groupId: binding(owners.sessionGroup, source) }
  }

  return {
    session,
    workspace,
    async authorize(principal, endpoint, payload, stream = false) {
      // Remote 入参有两种线上形态：命名对象（`{args:{...}}`）与位置数组（如 officeToPdf 的
      // `(workspaceFileScopeId, path, priority)`）。数组形态按空对象继续，由对应规则自行读取位置参数；
      // 其它端点拿到空对象后仍会因缺少归属证据而被拒。
      const raw = rawArgs(payload)
      const args = remoteArgs(payload) ?? (Array.isArray(raw) ? {} : undefined)
      if (args === undefined) return false
      // 「仅本人可写」必须先于管理员直通：管理员可读他人会话，但不得写入。
      if (!stream) {
        const writeTarget = conversationWriteTarget(endpoint, args)
        if (writeTarget !== undefined && !sessionWrite(principal, writeTarget)) return false
      }
      if (principal.role === 'admin') return true
      const request = requestOf(args)
      const [namespace, method, extra] = endpoint.split('/')
      if (extra !== undefined) return false
      if (stream) {
        if (endpoint === '$events') return true
        if (endpoint === 'session/control') return true
        if (endpoint === 'session/follow') return authorizeSession(args, principal)
        if (endpoint === 'workspace/follow') return true
        if (endpoint === 'workspaceFiles/changes') {
          return session(principal, args.workspaceFileScopeId)
            && await pathAllowed(principal, args.workspaceFileScopeId, args.path)
        }
        return false
      }
      if (endpoint === '$events/result') {
        // Correlated by the gateway against delivered waterfall frames; never by payload alone.
        return false
      }
      if (SHARED_READ.has(endpoint)) return true
      // 0.2.0 新增的插件管理器页：普通用户只读（listPlugins/listBundles/registries/inspect）——
      // 与 0.1.5 的 pluginInventory/list 同理，被拒会让整页显示失败；安装/卸载/启停与
      // pluginRegistryProbe/* 是部署方能力，仍未登记 → 默认拒绝。
      if (endpoint.startsWith('pluginManager/')) {
        return PLUGIN_MANAGER_READ.has(endpoint.slice('pluginManager/'.length))
      }
      // 权限预设目录是只读元数据（写入走 settings/mutate，仍限管理员）。
      if (endpoint === 'permissionPresets/catalog') return true
      // 交互式提问：**作答**是写动作（agentId 或 sessionId 任一归属本人），
      // **等待**只是挂起观察（组内可读会话也允许，否则只读查看会卡在题目上）。
      if (SESSION_INTERACTIVE.has(endpoint)) {
        if (endpoint === 'userQuestions/answer') {
          return agentWrite(principal, args) || sessionWrite(principal, request.sessionId ?? args.sessionId)
        }
        return agent(principal, args) || session(principal, request.sessionId ?? args.sessionId)
      }
      // 文档预览（Q8：用户 + 会话 + 工作区三重归属）。宿主以 workspaceFileScope（SessionId）
      // 解析路径，所以该 scope 必须属于请求者；入参若另给 workspaceId，其归属也必须一致。
      // 缺少可证明归属的 scope 时拒绝（fail-closed），不做"仅凭 path 放行"的推断。
      if (endpoint.startsWith('officeToPdf/')) {
        const scope = Array.isArray(raw) ? raw[OFFICE_TO_PDF_SCOPE_INDEX] : args.workspaceFileScopeId
        if (!session(principal, scope)) return false
        const workspaceId = Array.isArray(raw) ? undefined : args.workspaceId
        if (workspaceId !== undefined && !workspace(principal, workspaceId)) return false
        const path = Array.isArray(raw) ? raw[OFFICE_TO_PDF_PATH_INDEX] : args.path
        return await pathAllowed(principal, scope, path)
      }
      // open-in-app 的应用清单按会话归属（等价于按用户）。
      if (endpoint === 'session/workspacePathApplications') {
        return session(principal, request.sessionId ?? args.sessionId)
      }
      // 账户页（DeepSeek 登录 / 余额 / 充值）读的是**部署者**的账号与钱包，普通用户整体不开放
      // （Q7）；余额改由本插件的 balanceQuery 按用户自己的配置提供。此处显式拒绝以便审计。
      if (namespace === 'account') return false
      // Agent 预设：读清单与"为本次会话选择预设"是普通用户的正常能力——设置面板的【Agent 预设】
      // 页在加载时先调 agentPresets/list（被拒会让整页显示「无法加载 Agent 预设」），新建会话的
      // 预设选择器同样依赖它。read/select 是 agent 作用域（wire 名 agentId），按会话属主校验。
      // 只有 copy/deletePreset 会写出新的预设组合（可挂载插件与提示词），仍限管理员。
      if (endpoint === 'agentPresets/list') return true
      // read 是只读面（组内可读会话也要能用），select 会改写会话的预设 → 写谓词。
      if (endpoint === 'agentPresets/read') return agent(principal, args)
      if (endpoint === 'agentPresets/select') return agentWrite(principal, args)
      // 插件清单：普通用户可以查看本部署已安装的插件（只读），但安装/卸载/插件设置仍限管理员。
      // 白名单按端点登记，因此宿主后续新增的 pluginInventory/* 写操作默认仍是被拒的。
      if (endpoint === 'pluginInventory/list') return true
      if (namespace === 'session') {
        if (SESSION_READ.has(method as string)) return true
        if (method === 'page' || method === 'follow') return authorizeSession(args, principal)
        if (method === 'create') {
          // A deployment-provisioned Workspace owns the location; a client cannot override it with cwd.
          // 建会话只能落在自己的私有空间或自己所在组的组工作区里（组工作区的会话对组可见，
          // 私有空间的会话只属于本人）—— 两者都由 workspaceWrite 判定，路径不可由客户端指定。
          if (!workspaceWrite(principal, request.workspaceId) || request.cwd !== undefined) return false
          if (request.sessionId === undefined) return true
          if (!nonempty(request.sessionId)) return false
          return sessionWrite(principal, request.sessionId) || !(await owners.sessionExists(request.sessionId))
        }
        if (SESSION_BY_ID.has(method as string)) {
          if (method === 'selectModel') {
            // R2：切换模型必须落在该用户被授权的 provider/model 之内（未配置授权时维持原行为）。
            const scope = await entitlementOf(principal)
            if (scope !== undefined) {
              const provider = request.provider ?? args.provider
              const model = request.model ?? args.model
              if (!allowedProvider(scope, provider) || !allowedModel(scope, provider, model)) return false
            }
          }
          // prompt/attachment/cancel/rename/fork/updateQueue/selectModel 全部是写动作：仅归属人本人。
          return sessionWrite(principal, request.sessionId)
        }
        return false
      }
      if (namespace === 'workspace') {
        // 归档他人的会话属于写动作。
        if (method === 'archiveSession') return sessionWrite(principal, request.sessionId)
        if (WORKSPACE_BY_ID.has(method as string)) {
          // 改名/删除/工作区级排序是管理权；会话级排序沿用「能写这个工作区」。
          const allowed = method === 'insertSessionBefore'
            ? workspaceWrite(principal, request.workspaceId)
            : workspaceManage(principal, request.workspaceId)
          if (!allowed) return false
          if (request.beforeWorkspaceId !== undefined && !workspaceWrite(principal, request.beforeWorkspaceId)) return false
          return [request.sessionId, request.beforeSessionId].every(id => id === undefined || sessionWrite(principal, id))
        }
        // Workspace creation stays deployment-owned: a path is a host capability, not a user one.
        return false
      }
      if (namespace === 'workspaceFiles') {
        return session(principal, args.workspaceFileScopeId)
          && await pathAllowed(principal, args.workspaceFileScopeId, args.path, args.baseFile)
      }
      if (endpoint === 'skills/list') return session(principal, request.sessionId)
      if (endpoint === 'fileReferences/list') return agent(principal, args)
      if (endpoint === 'sessionReferenceResolver/candidates') return agent(principal, args)
      if (endpoint === 'fileUploads/upload') return agentWrite(principal, args)
      if (endpoint === 'commands/list') return agent(principal, args)
      if (namespace === 'goals') return agentWrite(principal, args)
      if (namespace === 'messageFeedback') return sessionWrite(principal, request.sessionId)
      if (endpoint === 'sessionFeedback/record') return sessionWrite(principal, request.sessionId)
      // Commands may change permissions, filesystem access or plugins; deployments opt in per command.
      // Settings/credentials/plugins/presets/directory picking/dynamic Cordis stay administrator-only.
      return false
    },
    async result(principal, endpoint, value, payload) {
      const record = object(value) ? value : undefined
      if (record !== undefined && ['session/create', 'session/fork'].includes(endpoint) && nonempty(record.sessionId)) {
        await owners.claimSession(record.sessionId, principal.username)
        // B1/B3：会话在创建时**冻结**工作区与组绑定 ——
        // 在组工作区里建 → 会话属于该组（组内可读）；在私有空间里建 → 无组 = 私有。
        // fork 继承源会话的绑定，源会话换组/换工作区不会把已有会话带走。
        const binding = sessionBinding(endpoint, payload)
        await owners.bindSession(record.sessionId, binding.workspaceId, binding.groupId)
      }
      if (principal.role === 'admin') return value
      // R2：按登录用户裁剪模型目录与 provider 列表。
      // 真实 0.2.0 形状（实测）：`{ default:{provider,model}, routableProviders:[id], groups:[{id,name,models:[{id,…}]}] }`；
      // 仍兼容早期猜测的 `providers` 字段名。形状不认识时原样返回，绝不误删。
      const modelScope = await entitlementOf(principal)
      if (modelScope !== undefined) {
        if (endpoint === 'session/modelCatalog' && record !== undefined) {
          const groupKey = Array.isArray(record.groups) ? 'groups' : (Array.isArray(record.providers) ? 'providers' : undefined)
          if (groupKey !== undefined) {
            const groups = (record[groupKey] as unknown[]).flatMap(group => {
              const provider = rowId(group)
              if (!allowedProvider(modelScope, provider)) return []
              const models = object(group) && Array.isArray(group.models) ? group.models : undefined
              if (models === undefined) return [group]
              const kept = models.filter(model => allowedModel(modelScope, provider, rowModel(model)))
              return kept.length === 0 ? [] : [{ ...(group as JsonObject), models: kept }]
            })
            const routable = Array.isArray(record.routableProviders)
              ? (record.routableProviders as unknown[]).filter(provider => allowedProvider(modelScope, provider))
              : undefined
            const defaultSelection = object(record.default) ? record.default : undefined
            const keepDefault = defaultSelection !== undefined
              && allowedProvider(modelScope, rowId(defaultSelection))
              && allowedModel(modelScope, rowId(defaultSelection), rowModel(defaultSelection))
            return {
              ...record,
              [groupKey]: groups,
              ...(routable === undefined ? {} : { routableProviders: routable }),
              // 默认选择若已不在授权内就清空，避免界面把越界模型当作默认值回填。
              ...(defaultSelection === undefined || keepDefault ? {} : { default: undefined }),
            }
          }
        }
        if ((endpoint === 'llm/listProviders' || endpoint === 'llm/listConfigurableProviders') && Array.isArray(value)) {
          return (value as unknown[]).filter(row => allowedProvider(modelScope, rowId(row)))
        }
      }
      if (['session/list', 'session/search'].includes(endpoint)) {
        const all = arrayOf(record?.items)
        const items = all.filter(item => session(principal, object(item) ? item.sessionId : undefined))
        const filtered = items.length < ((record?.items as unknown[] | undefined)?.length ?? 0)
        return { ...(record ?? {}), items, ...(filtered && record !== undefined && 'hasMore' in record ? { hasMore: false } : {}) }
      }
      if (record !== undefined && Array.isArray(record.workspaceIds)) {
        return { ...record, workspaceIds: record.workspaceIds.filter(id => workspace(principal, id)) }
      }
      if (record !== undefined && Array.isArray(record.archivedSessionIds)) {
        return { ...record, archivedSessionIds: record.archivedSessionIds.filter(id => session(principal, id)) }
      }
      if (record !== undefined && record.workspace !== undefined) {
        return { ...record, workspace: workspaceValue(principal, object(record.workspace) ? record.workspace : {}) }
      }
      return value
    },
    frame(principal, endpoint, value, correlation) {
      const frame = object(value) ? value : {}
      if (endpoint === '$events') {
        if (frame.type === 'ready') { correlation.clientId = frame.clientId as string; return value }
        if (frame.type === 'waterfall') {
          // Only a waterfall whose owning Session belongs to this principal is delivered;
          // a hidden recipient is released by the gateway with `next` (see modern-gateway).
          if (!session(principal, frame.agentId)) return null
          if (correlation.events.size >= 512) throw new Error('Too many pending Remote events')
          correlation.events.add(frame.eventId as string)
          return value
        }
        if (frame.type === 'cancel') return correlation.events.delete(frame.eventId as string) ? value : null
        if (frame.type !== 'emit') return null
        // Global registries (commands/change, credentials/reference-updated, llm/adapters-updated,
        // settings/document-updated, cordis/*-resolved, cordis/dynamic-*) carry no owner and are
        // therefore not shown to ordinary users.
        const args = arrayOf(frame.args) as Array<JsonObject | undefined>
        switch (frame.event) {
          case 'api-session/added': return session(principal, args[0]?.sessionId) ? value : null
          case 'api-session/activity':
          case 'api-session/error':
          case 'api-session/removed':
          case 'api-session/status':
          case 'agent-preset/selected': return session(principal, args[0]) ? value : null
          case 'goal/activation-changed': return session(principal, args[0]?.sessionId) ? value : null
          case 'cordis/request-run':
          case 'cordis/inspect-query': return session(principal, args[0]?.agentId) ? value : null
          default: return null
        }
      }
      if (principal.role === 'admin') return value
      if (endpoint === 'session/control') {
        if (frame.type === 'baseline') {
          const baseline = object(frame.value) ? frame.value : {}
          return { type: 'baseline', value: {
            queues: ownMap(principal, baseline.queues),
            jobs: ownMap(principal, baseline.jobs),
            projections: ownMap(principal, baseline.projections),
          } }
        }
        return session(principal, frame.sessionId) ? value : null
      }
      if (endpoint === 'workspace/follow') {
        if (frame.type === 'baseline') return { type: 'baseline', value: workspaceBaseline(principal, frame.value) }
        if (frame.type === 'order') return { ...frame, workspaceIds: arrayOf(frame.workspaceIds).filter(id => workspace(principal, id)) }
        if (frame.type === 'archived') return { ...frame, archivedSessionIds: arrayOf(frame.archivedSessionIds).filter(id => session(principal, id)) }
        if (frame.type === 'upsert') {
          const workspaceFrame = object(frame.workspace) ? frame.workspace : undefined
          return workspace(principal, workspaceFrame?.workspaceId) && workspaceFrame !== undefined
            ? { ...frame, workspace: workspaceValue(principal, workspaceFrame) }
            : null
        }
        if (frame.type === 'remove') return workspace(principal, frame.workspaceId) ? value : null
        return null
      }
      return value
    },
  }
}
