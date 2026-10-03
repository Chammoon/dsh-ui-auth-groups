/**
 * 组存储（组 = 项目）。
 *
 * 数据模型：一个用户名可以属于多个组，一个组可以有多名成员。
 * 组本身只描述**成员关系**；「哪些会话/工作区属于这个组」由归属表记录
 * （工作区绑定组 → 组工作区；在其中创建的会话冻结为该组的会话）。
 *
 * 权限模型（组只是可见性的一个来源，不再等同于「同组即可读」）：
 * - 无组的工作区/会话 = 私有：仅归属人可写、本人与管理员可读；
 * - 绑定组的对象：组内成员可读；写入仍只属于归属人本人。
 *
 * 约定与上游保持一致：
 * - 落盘走 `ctx.get('fs')` 服务（与 `dsh-ui-auth-groups-sessions.json` 同处的工作目录）；
 * - 防抖写 + 卸载 flush，内存态是权威（读谓词是同步热路径，不能等 IO）；
 * - 损坏文件**隔离**成 `.corrupt-<ts>` 而不是静默丢弃；
 * - 读不到、解析失败、fs 服务缺席时一律视为「空组表」→ 读谓词 fail-closed，
 *   故障绝不退化成「全员可读」。
 */

/** 一条组记录。`members` 存用户名（与登录账户同名，大小写敏感）。 */
export interface GroupRecord {
  id: string
  name: string
  members: string[]
  createdAt: number
  updatedAt: number
}

/** `ctx.get('fs')` 的最小结构面（与 index.ts 的 FsService 用法一致）。 */
export interface GroupFsService {
  resolve(name: string): Promise<string>
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<unknown>
}

/** 落盘状态。`v` 预留迁移位。 */
export interface GroupState {
  v: 1
  groups: GroupRecord[]
}

/** 组名与用户名的输入上限（防御性，前端另有校验）。 */
export const GROUP_NAME_MAX = 64
export const MEMBER_NAME_MAX = 64
const MEMBERS_MAX = 500

const FILE = 'dsh-ui-auth-groups-groups.json'
const SAVE_DEBOUNCE_MS = 200

/** 组名非空、去首尾空白、限长。 */
export function normalizeGroupName(name: unknown): string {
  const text = typeof name === 'string' ? name.trim() : ''
  if (text === '') throw new Error('group name must not be empty')
  if (text.length > GROUP_NAME_MAX) throw new Error(`group name must be at most ${GROUP_NAME_MAX} characters`)
  return text
}

/** 成员名清洗：去空白与重复，丢弃空串。 */
function normalizeMembers(members: unknown): string[] {
  if (!Array.isArray(members)) return []
  const seen = new Set<string>()
  for (const raw of members) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (name === '' || name.length > MEMBER_NAME_MAX) continue
    seen.add(name)
    if (seen.size >= MEMBERS_MAX) break
  }
  return [...seen]
}

export class GroupStore {
  private readonly groups = new Map<string, GroupRecord>()
  /** username -> groupIds；读谓词热路径用，避免每次遍历全部组。 */
  private readonly index = new Map<string, Set<string>>()
  private loaded = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly fs: () => GroupFsService | undefined) {}

  /** 从磁盘装载。失败/损坏一律落成空表（fail-closed），并隔离损坏文件。 */
  async load(): Promise<void> {
    if (this.loaded) return
    const fs = this.fs()
    if (fs === undefined) return // fs 服务尚未就绪：保持空表，之后首次写操作会重试
    let text: string
    try {
      const target = await fs.resolve(FILE)
      text = await fs.readText(target)
    } catch {
      this.loaded = true // 文件不存在 = 全新部署
      return
    }
    let parsed: GroupState | undefined
    try {
      const value = JSON.parse(text) as Partial<GroupState> | null
      if (value !== null && typeof value === 'object' && Array.isArray(value.groups)) {
        parsed = { v: 1, groups: value.groups as GroupRecord[] }
      }
    } catch { /* 下面统一按损坏处理 */ }
    if (parsed === undefined) {
      await this.quarantine(fs, text)
      this.loaded = true
      return
    }
    for (const record of parsed.groups) {
      if (record === null || typeof record !== 'object') continue
      if (typeof record.id !== 'string' || record.id === '') continue
      let name: string
      try {
        name = normalizeGroupName(record.name)
      } catch {
        continue
      }
      const group: GroupRecord = {
        id: record.id,
        name,
        members: normalizeMembers(record.members),
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
      }
      this.put(group)
    }
    this.loaded = true
  }

  /** 损坏文件隔离：写一份 `.corrupt-<ts>` 供人工取证，原文件不再被复用。 */
  private async quarantine(fs: GroupFsService, text: string): Promise<void> {
    console.error('[dsh-ui-auth-groups] 组文件无法解析，已隔离为 .corrupt 副本并重置为空组表')
    try {
      const target = await fs.resolve(`${FILE}.corrupt-${Date.now()}`)
      await fs.writeText(target, text)
    } catch { /* 取证副本尽力而为 */ }
  }

  /** 写入内存索引（唯一入口，保证 groups 与 index 一致）。 */
  private put(group: GroupRecord): void {
    const previous = this.groups.get(group.id)
    if (previous !== undefined) {
      for (const member of previous.members) this.detach(member, group.id)
    }
    this.groups.set(group.id, group)
    for (const member of group.members) {
      let set = this.index.get(member)
      if (set === undefined) {
        set = new Set<string>()
        this.index.set(member, set)
      }
      set.add(group.id)
    }
  }

  private detach(member: string, groupId: string): void {
    const set = this.index.get(member)
    if (set === undefined) return
    set.delete(groupId)
    if (set.size === 0) this.index.delete(member)
  }

  /**
   * 读谓词核心：`username` 是否属于 `groupId` 这个组。
   *
   * 可见性判定从「同组可读」改成「查看者 ∈ 对象所属组」之后，这里只回答成员关系：
   * 同步、O(1)，任何异常路径返回 false（fail-closed）。
   */
  isMember(username: string, groupId: string): boolean {
    if (username === '' || groupId === '') return false
    const ids = this.index.get(username)
    return ids !== undefined && ids.has(groupId)
  }

  /** 某用户所在的组 id 集合（快照，供策略层与面板使用）。 */
  groupIdsOf(username: string): string[] {
    const ids = this.index.get(username)
    return ids === undefined ? [] : [...ids]
  }

  list(): GroupRecord[] {
    return [...this.groups.values()].sort((x, y) => x.name.localeCompare(y.name))
  }

  get(id: string): GroupRecord | undefined {
    return this.groups.get(id)
  }

  /** 某用户所在的全部组（面板用）。 */
  groupsOf(username: string): GroupRecord[] {
    const ids = this.index.get(username)
    if (ids === undefined) return []
    const out: GroupRecord[] = []
    for (const id of ids) {
      const group = this.groups.get(id)
      if (group !== undefined) out.push(group)
    }
    return out.sort((x, y) => x.name.localeCompare(y.name))
  }

  create(input: { name: unknown; members?: unknown }): GroupRecord {
    const name = normalizeGroupName(input.name)
    if (this.list().some(group => group.name === name)) throw new Error(`group name already exists: ${name}`)
    const now = Date.now()
    const record: GroupRecord = {
      id: globalThis.crypto.randomUUID(),
      name,
      members: normalizeMembers(input.members),
      createdAt: now,
      updatedAt: now,
    }
    this.put(record)
    this.scheduleSave()
    return record
  }

  rename(id: string, name: unknown): GroupRecord {
    const record = this.require(id)
    const next = normalizeGroupName(name)
    if (this.list().some(group => group.name === next && group.id !== id)) {
      throw new Error(`group name already exists: ${next}`)
    }
    const updated: GroupRecord = { ...record, name: next, updatedAt: Date.now() }
    this.put(updated)
    this.scheduleSave()
    return updated
  }

  /** 覆盖式设置成员（管理员的成员增删改查都走这里，语义最不容易出错）。 */
  setMembers(id: string, members: unknown): GroupRecord {
    const record = this.require(id)
    const updated: GroupRecord = { ...record, members: normalizeMembers(members), updatedAt: Date.now() }
    this.put(updated)
    this.scheduleSave()
    return updated
  }

  remove(id: string): void {
    const record = this.require(id)
    for (const member of record.members) this.detach(member, id)
    this.groups.delete(id)
    this.scheduleSave()
  }

  /** 用户被删除时从所有组里摘除（调用方负责在账户删除流程里调用）。 */
  removeMemberEverywhere(username: string): number {
    let touched = 0
    const ids = [...(this.index.get(username) ?? [])]
    for (const id of ids) {
      const record = this.groups.get(id)
      if (record === undefined) continue
      const updated: GroupRecord = { ...record, members: record.members.filter(m => m !== username), updatedAt: Date.now() }
      this.put(updated)
      touched += 1
    }
    if (touched > 0) this.scheduleSave()
    return touched
  }

  private require(id: string): GroupRecord {
    const record = this.groups.get(String(id))
    if (record === undefined) throw new Error(`group not found: ${id}`)
    return record
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saving = this.writeNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeNow(): Promise<void> {
    const fs = this.fs()
    if (fs === undefined) return
    const state: GroupState = { v: 1, groups: this.list() }
    try {
      const target = await fs.resolve(FILE)
      await fs.writeText(target, `${JSON.stringify(state, null, 2)}\n`)
    } catch (err) {
      console.error('[dsh-ui-auth-groups] 写入组文件失败: ' + String(err))
    }
  }

  /** 强制落盘（卸载/更新时调用）。 */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.saving
    if (this.loaded) await this.writeNow()
  }

  /** 仅供测试与探针：内存态快照。 */
  snapshot(): GroupState {
    return { v: 1, groups: this.list() }
  }
}

export default GroupStore
