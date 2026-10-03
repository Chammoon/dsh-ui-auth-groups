/**
 * 私有空间 / 组工作区（项目空间）—— 目录推导与供给。
 *
 * 权限模型把「工作区是否绑定组」当作可见性的唯一开关：
 * - **未绑定组 = 私有空间**：只有归属人本人（与管理员只读）能看，会话也只能建在这里；
 * - **绑定组 = 组工作区**：组内任何成员都能看到它、并能在其中建会话；建出来的会话
 *   冻结为该组的会话（组内可读），写入仍只属于会话归属人。
 *
 * 目录布局（root 见 {@link readSpaceConfig}，默认 `<DSH_HOME>/spaces`）：
 *   `<root>/users/<用户名>`          —— 每个人的私有空间（登录后自动供给）
 *   `<root>/groups/<组名>-<id8>`     —— 每个组的项目空间（管理员显式创建）
 *
 * 本模块只做「目录 + 登记」这一件事：工作区记录本身由宿主 `workspaceRegistry`
 * 持有（DSH 侧栏读的就是它），归属/组绑定由调用方经 `SpaceDeps` 写进归属表。
 * 所有失败路径都必须**显式抛错或返回 undefined**，绝不静默降级成「谁都能看」。
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, normalize, posix, resolve, sep, win32 } from 'node:path'

/** 目录名长度上限（截断后仍与 id 后缀拼成合法文件名）。 */
export const SEGMENT_MAX = 48

/** 宿主 `workspaceRegistry` 的最小结构面（`Workspace` 实体：id/path/title）。 */
export interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<unknown>
  get?(id: string): unknown
  list?(): unknown
}

/** 一个已登记的工作区（只保留本插件用得到的字段）。 */
export interface SpaceWorkspace {
  id: string
  path: string
  title: string
}

/** 供给依赖；全部可注入，便于单测与宿主缺席时的显式报错。 */
export interface SpaceDeps {
  /** 宿主工作区注册表；缺席时供给直接失败（面板会提示宿主不支持）。 */
  readonly registry?: WorkspaceRegistryLike | undefined
  /** 空间根目录（绝对路径）。 */
  readonly root: string
  /** 建目录（默认 `node:fs/promises.mkdir`, recursive）。 */
  readonly mkdir?: ((path: string) => Promise<unknown>) | undefined
  /** 认领工作区归属（写入归属表，重复认领同一属主必须幂等）。 */
  readonly claim: (workspaceId: string, username: string) => Promise<void>
  /** 记录工作区 → 组 的绑定（groupId 为 undefined 表示解除）。 */
  readonly bindGroup: (workspaceId: string, groupId: string | undefined) => Promise<void>
  /** 记录「某人的私有工作区」。 */
  readonly rememberPrivate: (username: string, workspaceId: string) => Promise<void>
  /** 已登记的私有工作区 id（命中且注册表仍在时免去目录与写盘开销）。 */
  readonly knownPrivate: (username: string) => string | undefined | Promise<string | undefined>
  /** 诊断日志（缺省 console.error）。 */
  readonly log?: ((message: string) => void) | undefined
}

/** 空间配置：根目录 + 是否允许自动供给。 */
export interface SpaceConfig {
  root: string
  /** `false` 时登录/建组不再自动建目录（管理员仍可显式供给）。 */
  enabled: boolean
}

const DISABLED = new Set(['0', 'false', 'off', 'no'])

/** 环境变量 → 空间配置。`DSH_AUTH_WORKSPACES_DIR` 覆盖根目录，`DSH_AUTH_PROVISION=0` 关闭自动供给。 */
export function readSpaceConfig(env: Record<string, string | undefined> = {}): SpaceConfig {
  const configured = nonEmptyText(env.DSH_AUTH_WORKSPACES_DIR)
  const home = nonEmptyText(env.DSH_HOME) ?? homedir() + sep + '.dsh'
  const root = resolve(configured ?? home + sep + 'spaces')
  const flag = nonEmptyText(env.DSH_AUTH_PROVISION)
  return { root, enabled: flag === undefined || !DISABLED.has(flag.toLowerCase()) }
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 目录名安全化：保留字母/数字/`.`/`_`/`-`（含 CJK 等 Unicode 字母），其余折叠成 `-`，
 * 去掉首尾的点与横线，限长。结果是**不含路径分隔符**的片段；调用方仍须做包含性校验。
 * 清洗后为空时返回 `fallback`（不含去重后缀；去重见 {@link workspaceSegment}）。
 */
export function safeSegment(raw: unknown, fallback: string): string {
  const cut = cleanSegment(raw)
  return cut === '' ? fallback : cut
}

/** 清洗后的片段（可能为空串）。 */
function cleanSegment(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.normalize('NFKC').trim() : ''
  return text
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
    .slice(0, SEGMENT_MAX)
}

/**
 * 目录片段 + 去重后缀。
 *
 * `safeSegment` 会把不同输入折叠成同一片段（`..` / `--` / 空串 → 同一个 fallback），
 * 直接当目录名会让两个账户共用同一份私有空间（第二个账户的工作区认领会失败）。
 * 因此凡是「清洗结果 ≠ 原样」的输入都追加一段短哈希，保证不同用户名落到不同目录。
 */
export function workspaceSegment(raw: unknown, fallback: string): string {
  const text = typeof raw === 'string' ? raw.normalize('NFKC').trim() : ''
  const cleaned = cleanSegment(raw)
  if (cleaned === '') return fallback + '-' + shortHash(text)
  return cleaned === text ? cleaned : cleaned + '-' + shortHash(text)
}

/** FNV-1a 32 位：只用于目录名去重（不是安全用途，碰撞也只会让认领失败 = fail-closed）。 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 路径收敛：`path`（绝对，或相对 `baseFile` 所在目录 / 工作区根）是否落在 `root` 之内。
 *
 * 宿主 `workspaceFiles/read|readBytes|stat` **不限制**路径（其文档明说 "files outside it
 * are allowed"），因此普通用户只要能读任一会话，就能读到进程可读的任意文件
 * （`~/.dsh/.credentials.yaml`、别人的私有空间、会话日志……）。这里在策略层补上包含性判定。
 * @returns 规范化后的绝对路径；越界、拼写非法或无法判定时返回 `undefined`（fail-closed）。
 */
export function confinePath(root: unknown, path: unknown, baseFile?: unknown): string | undefined {
  const rootText = typeof root === 'string' ? root.trim() : ''
  const pathText = typeof path === 'string' ? path.trim() : ''
  if (rootText === '' || pathText === '') return undefined
  const api = /^[A-Za-z]:[\\/]/.test(rootText) || rootText.startsWith('\\\\') ? win32 : posix
  const absoluteRoot = api.resolve(rootText)
  // 相对路径以 baseFile 所在目录为基准；没有 baseFile 时以工作区根为基准。
  const baseText = typeof baseFile === 'string' ? baseFile.trim() : ''
  const baseDir = baseText !== '' && api.isAbsolute(baseText) ? api.dirname(api.normalize(baseText)) : absoluteRoot
  const candidate = api.isAbsolute(pathText) ? api.resolve(pathText) : api.resolve(baseDir, pathText)
  // Windows 路径大小写不敏感：比较前统一折叠，避免同目录被误判为越界（或反之）。
  const fold = (value: string): string => (api === win32 ? value.toLowerCase() : value)
  const target = fold(normalize(candidate))
  const baseFold = fold(absoluteRoot)
  if (target === baseFold) return target
  return target.startsWith(baseFold + api.sep) ? target : undefined
}

/** 从宿主工作区实体里取出 {id,path,title}；形状不认识时返回 undefined。 */
export function spaceWorkspaceOf(value: unknown): SpaceWorkspace | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = nonEmptyText(record.id)
  if (id === undefined) return undefined
  return {
    id,
    path: nonEmptyText(record.path) ?? '',
    title: nonEmptyText(record.title) ?? id,
  }
}

/** 注册表里所有工作区的 {id,path,title} 投影（无注册表/形状异常时为空）。 */
export function listSpaceWorkspaces(registry: WorkspaceRegistryLike | undefined): SpaceWorkspace[] {
  if (registry?.list === undefined) return []
  let raw: unknown
  try { raw = registry.list() } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: SpaceWorkspace[] = []
  for (const entry of raw) {
    const workspace = spaceWorkspaceOf(entry)
    if (workspace !== undefined) out.push(workspace)
  }
  return out
}

/** 单个工作区的描述（含 id 兜底），注册表里没有时返回 undefined。 */
export function describeSpaceWorkspace(registry: WorkspaceRegistryLike | undefined, id: string): SpaceWorkspace | undefined {
  if (registry?.get === undefined) return undefined
  try { return spaceWorkspaceOf(registry.get(id)) } catch { return undefined }
}

/**
 * 私有空间 / 组工作区的供给器。
 *
 * 幂等：同一个用户名/组重复调用只会复用同一个工作区（宿主的 `create` 按 canonical
 * path 去重），因此可以在每次登录时安全调用。
 */
export class SpaceProvisioner {
  constructor(private readonly deps: SpaceDeps) {}

  /** 宿主是否支持自动供给（注册表缺席时面板应给出可操作的提示）。 */
  get available(): boolean {
    return this.deps.registry !== undefined
  }

  /** 私有空间目录：`<root>/users/<用户名>`（用户名含不安全字符时追加去重后缀）。 */
  privatePath(username: string): string {
    return this.under('users', workspaceSegment(username, 'user'))
  }

  /** 组工作区目录：`<root>/groups/<组名>-<id 前 8 位>`（id 后缀保证组之间不撞名）。 */
  groupPath(group: { id: string; name: string }): string {
    const suffix = safeSegment(group.id.replace(/-/g, '').slice(0, 8), 'grp')
    return this.under('groups', safeSegment(group.name, 'group') + '-' + suffix)
  }

  /** 子目录的包含性校验：任何逃出 root 的拼写都在这里被拒绝（而不是靠上游清洗）。 */
  private under(kind: 'users' | 'groups', segment: string): string {
    const base = resolve(this.deps.root, kind)
    const target = resolve(base, segment)
    if (target === base || !target.startsWith(base + sep)) throw new Error('工作区目录名非法')
    return target
  }

  private async makeDirectory(path: string): Promise<void> {
    const mkdir = this.deps.mkdir ?? defaultMkdir
    await mkdir(path)
  }

  /**
   * 确保某个用户拥有私有空间。
   * @returns 工作区；宿主注册表缺席时抛错（调用方决定是否降级成日志）。
   */
  async ensurePrivate(username: string): Promise<SpaceWorkspace> {
    const known = await this.deps.knownPrivate(username)
    if (known !== undefined) {
      const existing = describeSpaceWorkspace(this.deps.registry, known)
      if (existing !== undefined) return existing
    }
    const path = this.privatePath(username)
    return await this.provision(path, username, async (id) => {
      await this.deps.claim(id, username)
      await this.deps.rememberPrivate(username, id)
    })
  }

  /**
   * 确保某个组拥有组工作区（并把工作区绑定到该组）。
   * @param group - 组 id 与当前名称（名称只用于目录与标题）。
   */
  async ensureGroup(group: { id: string; name: string }): Promise<SpaceWorkspace> {
    const path = this.groupPath(group)
    return await this.provision(path, group.name, async (id) => {
      await this.deps.bindGroup(id, group.id)
    })
  }

  /** 建目录 → 注册工作区 → 登记归属/绑定。 */
  private async provision(
    path: string,
    title: string,
    register: (workspaceId: string) => Promise<void>,
  ): Promise<SpaceWorkspace> {
    const registry = this.deps.registry
    if (registry === undefined) throw new Error('宿主未提供 workspaceRegistry 服务，无法创建工作区')
    await this.makeDirectory(path)
    // 宿主按 canonical path 去重：目录已存在时返回既有工作区，不覆盖标题。
    const created = spaceWorkspaceOf(await registry.create(path, title))
    if (created === undefined) throw new Error('工作区服务返回了无法识别的结果')
    await register(created.id)
    return created
  }
}

/** 默认建目录实现：`node:fs/promises.mkdir`（动态导入，保证宿主无该模块时也只在这里失败）。 */
async function defaultMkdir(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}

export default SpaceProvisioner
