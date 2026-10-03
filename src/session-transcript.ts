/**
 * 会话转录提取（纯函数，可脱离 Cordis 单测）。
 *
 * 形状全部取自真实会话日志（`~/.dsh/sessions/.../session.v4.jsonl.zstd`，DSH 0.2.x）：
 *
 *   用户消息：{ type: 'user/message', seq, time, data: {
 *                content: [{ type: 'text', text }], source: { kind: 'user' | ... }, role: 'user', id } }
 *   助手消息：{ type: 'assistant/message', seq, time, data: { turn, step, message: {
 *                role: 'assistant', content: [{ type: 'text' | 'reasoning' | 'tool-call', ... }] } } }
 *   会话标题：{ type: 'session/title', seq, time, data: { title, messageSeqs, source } }
 *
 * 管理员视图是**只读**的：这里只做投影，不产生任何写回。
 */

/** 转录中的一条消息。`source` 用于区分真人输入与注入上下文（runtime 注入不是用户说的话）。 */
export interface TranscriptMessage {
  seq: number
  at: number
  role: 'user' | 'assistant'
  text: string
  /** 用户消息的来源种类：'user' 是真人输入；其它值（注入上下文等）会在界面上标注。 */
  source?: string
}

export interface Transcript {
  title?: string
  messages: TranscriptMessage[]
  /** 因上限被丢弃的早期消息条数（0 表示完整）。 */
  droppedMessages: number
  /** 被截断的单条消息数（超长正文按单条上限裁剪）。 */
  truncatedMessages: number
  /** 事件总数与其中被投影为消息的数量，便于判断"读到了多少"。 */
  eventCount: number
}

export interface TranscriptOptions {
  /** 最多返回多少条消息（从最新往回取）。默认 300。 */
  maxMessages?: number
  /** 单条消息正文字符上限。默认 8000。 */
  maxTextChars?: number
  /** 是否把注入类用户消息（source.kind !== 'user'）也算进转录。默认 false。 */
  includeInjected?: boolean
}

const DEFAULT_MAX_MESSAGES = 300
const DEFAULT_MAX_TEXT_CHARS = 8000

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 从 content 块数组里拼出可读正文：只取 text 块，跳过 reasoning 与 tool-call。 */
export function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (!isObject(block)) continue
    if (block.type !== 'text') continue
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * 从一条 `user/message` 事件里取正文与来源。
 * `data.content` 是当前格式；`data.message.content` 作为历史格式兜底。
 */
export function readUserMessage(event: Json): { text: string; source?: string } | undefined {
  const data = isObject(event.data) ? event.data : undefined
  if (data === undefined) return undefined
  const text = textOfBlocks(data.content) || textOfBlocks(isObject(data.message) ? data.message.content : undefined)
  if (text === '') return undefined
  const source = isObject(data.source) && typeof data.source.kind === 'string' ? data.source.kind : undefined
  return source === undefined ? { text } : { text, source }
}

/** 从一条 `assistant/message` 事件里取正文（只取 text 块，思考与工具调用不入转录）。 */
export function readAssistantMessage(event: Json): { text: string } | undefined {
  const data = isObject(event.data) ? event.data : undefined
  if (data === undefined) return undefined
  const message = isObject(data.message) ? data.message : undefined
  const text = textOfBlocks(message?.content) || textOfBlocks(data.content)
  return text === '' ? undefined : { text }
}

/** 折叠出最新的会话标题（标题是事件流里的一条记录，不在 header 上）。 */
export function foldTitle(events: readonly unknown[]): string | undefined {
  let title: string | undefined
  for (const raw of events) {
    if (!isObject(raw) || raw.type !== 'session/title') continue
    const data = isObject(raw.data) ? raw.data : undefined
    if (data !== undefined && typeof data.title === 'string' && data.title.trim() !== '') title = data.title
  }
  return title
}

/**
 * 把一份会话事件流投影成只读转录。
 *
 * 只保留用户可见的对话（真人输入 + 助手正文）；工具调用、思考、系统提示、
 * 审批与沙箱事件都不进转录。超长会话从**最新**往回取 `maxMessages` 条。
 */
export function buildTranscript(events: readonly unknown[], options: TranscriptOptions = {}): Transcript {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  const includeInjected = options.includeInjected === true

  const collected: TranscriptMessage[] = []
  for (const raw of events) {
    if (!isObject(raw)) continue
    const seq = typeof raw.seq === 'number' ? raw.seq : 0
    const at = typeof raw.time === 'number' ? raw.time : 0
    if (raw.type === 'user/message') {
      const read = readUserMessage(raw)
      if (read === undefined) continue
      // 注入上下文（AGENTS.md、技能正文、文件变更通知…）默认不算"用户说的话"。
      if (!includeInjected && read.source !== undefined && read.source !== 'user') continue
      collected.push(read.source === undefined
        ? { seq, at, role: 'user', text: read.text }
        : { seq, at, role: 'user', text: read.text, source: read.source })
      continue
    }
    if (raw.type === 'assistant/message') {
      const read = readAssistantMessage(raw)
      if (read === undefined) continue
      collected.push({ seq, at, role: 'assistant', text: read.text })
    }
  }

  const droppedMessages = Math.max(0, collected.length - maxMessages)
  const kept = droppedMessages === 0 ? collected : collected.slice(collected.length - maxMessages)

  let truncatedMessages = 0
  const messages = kept.map((message) => {
    if (message.text.length <= maxTextChars) return message
    truncatedMessages += 1
    return { ...message, text: `${message.text.slice(0, maxTextChars)}\n\n…（本条已截断）` }
  })

  const title = foldTitle(events)
  return {
    ...(title === undefined ? {} : { title }),
    messages,
    droppedMessages,
    truncatedMessages,
    eventCount: events.length,
  }
}

/** 归属查询：返回一个会话 id 的所属用户名。 */
export type OwnerLookup = (sessionId: string) => string

/** `sessionQuery.listSessions()` 记录的最小结构面。 */
export interface SessionRecordLike {
  header?: { id?: unknown; createdAt?: unknown; cwd?: unknown }
  live?: unknown
  persisted?: unknown
}

/** 面板条目上的附加标注（组/工作区绑定等；由调用方提供）。 */
export type EntryAnnotator = (sessionId: string) => Partial<SessionEntry> | undefined

/** 按用户分组的会话条目（面板用）。 */
export interface SessionEntry {
  id: string
  createdAt: number
  cwd?: string
  live: boolean
  persisted: boolean
  title?: string
  /** 会话冻结的组 id（无 = 私有会话）。 */
  groupId?: string
  /** 组名（组已被删除时不出现）。 */
  group?: string
  /** 会话创建时所在的工作区 id。 */
  workspaceId?: string
}

export interface UserSessions {
  username: string
  sessions: SessionEntry[]
}

/**
 * 把会话记录按归属人分组。
 *
 * - 未在归属表登记的会话由 `ownerOf` 决定（上游语义：未登记按 `admin` 处理）；
 * - 按创建时间倒序，用户按会话数倒序、同数按用户名排序；
 * - `titles` 是 `id -> 标题` 的旁路表（由调用方择机补齐，缺失就不显示标题）；
 * - `annotate` 给每条条目补组/工作区等字段（返回 undefined 表示无附加信息）。
 */
export function groupByOwner(
  records: readonly SessionRecordLike[],
  ownerOf: OwnerLookup,
  titles?: ReadonlyMap<string, string>,
  annotate?: EntryAnnotator,
): UserSessions[] {
  const byUser = new Map<string, SessionEntry[]>()
  for (const record of records) {
    const header = isObject(record.header) ? record.header : undefined
    const id = header !== undefined && typeof header.id === 'string' ? header.id : ''
    if (id === '') continue
    const username = ownerOf(id)
    const entry: SessionEntry = {
      id,
      createdAt: header !== undefined && typeof header.createdAt === 'number' ? header.createdAt : 0,
      live: record.live === true,
      persisted: record.persisted === true,
    }
    if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '') entry.cwd = header.cwd
    const title = titles?.get(id)
    if (title !== undefined && title !== '') entry.title = title
    const extra = annotate?.(id)
    if (extra !== undefined) Object.assign(entry, extra)
    const bucket = byUser.get(username)
    if (bucket === undefined) byUser.set(username, [entry])
    else bucket.push(entry)
  }
  const users: UserSessions[] = []
  for (const [username, sessions] of byUser) {
    sessions.sort((a, b) => b.createdAt - a.createdAt)
    users.push({ username, sessions })
  }
  users.sort((a, b) => (b.sessions.length - a.sessions.length) || a.username.localeCompare(b.username))
  return users
}
