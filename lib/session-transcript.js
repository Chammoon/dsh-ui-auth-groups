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
const DEFAULT_MAX_MESSAGES = 300;
const DEFAULT_MAX_TEXT_CHARS = 8000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 从 content 块数组里拼出可读正文：只取 text 块，跳过 reasoning 与 tool-call。 */
export function textOfBlocks(blocks) {
    if (!Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (!isObject(block))
            continue;
        if (block.type !== 'text')
            continue;
        if (typeof block.text === 'string' && block.text !== '')
            parts.push(block.text);
    }
    return parts.join('\n\n');
}
/**
 * 从一条 `user/message` 事件里取正文与来源。
 * `data.content` 是当前格式；`data.message.content` 作为历史格式兜底。
 */
export function readUserMessage(event) {
    const data = isObject(event.data) ? event.data : undefined;
    if (data === undefined)
        return undefined;
    const text = textOfBlocks(data.content) || textOfBlocks(isObject(data.message) ? data.message.content : undefined);
    if (text === '')
        return undefined;
    const source = isObject(data.source) && typeof data.source.kind === 'string' ? data.source.kind : undefined;
    return source === undefined ? { text } : { text, source };
}
/** 从一条 `assistant/message` 事件里取正文（只取 text 块，思考与工具调用不入转录）。 */
export function readAssistantMessage(event) {
    const data = isObject(event.data) ? event.data : undefined;
    if (data === undefined)
        return undefined;
    const message = isObject(data.message) ? data.message : undefined;
    const text = textOfBlocks(message?.content) || textOfBlocks(data.content);
    return text === '' ? undefined : { text };
}
/** 折叠出最新的会话标题（标题是事件流里的一条记录，不在 header 上）。 */
export function foldTitle(events) {
    let title;
    for (const raw of events) {
        if (!isObject(raw) || raw.type !== 'session/title')
            continue;
        const data = isObject(raw.data) ? raw.data : undefined;
        if (data !== undefined && typeof data.title === 'string' && data.title.trim() !== '')
            title = data.title;
    }
    return title;
}
/**
 * 把一份会话事件流投影成只读转录。
 *
 * 只保留用户可见的对话（真人输入 + 助手正文）；工具调用、思考、系统提示、
 * 审批与沙箱事件都不进转录。超长会话从**最新**往回取 `maxMessages` 条。
 */
export function buildTranscript(events, options = {}) {
    const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    const includeInjected = options.includeInjected === true;
    const collected = [];
    for (const raw of events) {
        if (!isObject(raw))
            continue;
        const seq = typeof raw.seq === 'number' ? raw.seq : 0;
        const at = typeof raw.time === 'number' ? raw.time : 0;
        if (raw.type === 'user/message') {
            const read = readUserMessage(raw);
            if (read === undefined)
                continue;
            // 注入上下文（AGENTS.md、技能正文、文件变更通知…）默认不算"用户说的话"。
            if (!includeInjected && read.source !== undefined && read.source !== 'user')
                continue;
            collected.push(read.source === undefined
                ? { seq, at, role: 'user', text: read.text }
                : { seq, at, role: 'user', text: read.text, source: read.source });
            continue;
        }
        if (raw.type === 'assistant/message') {
            const read = readAssistantMessage(raw);
            if (read === undefined)
                continue;
            collected.push({ seq, at, role: 'assistant', text: read.text });
        }
    }
    const droppedMessages = Math.max(0, collected.length - maxMessages);
    const kept = droppedMessages === 0 ? collected : collected.slice(collected.length - maxMessages);
    let truncatedMessages = 0;
    const messages = kept.map((message) => {
        if (message.text.length <= maxTextChars)
            return message;
        truncatedMessages += 1;
        return { ...message, text: `${message.text.slice(0, maxTextChars)}\n\n…（本条已截断）` };
    });
    const title = foldTitle(events);
    return {
        ...(title === undefined ? {} : { title }),
        messages,
        droppedMessages,
        truncatedMessages,
        eventCount: events.length,
    };
}
/**
 * 把会话记录按归属人分组。
 *
 * - 未在归属表登记的会话由 `ownerOf` 决定（上游语义：未登记按 `admin` 处理）；
 * - 按创建时间倒序，用户按会话数倒序、同数按用户名排序；
 * - `titles` 是 `id -> 标题` 的旁路表（由调用方择机补齐，缺失就不显示标题）。
 */
export function groupByOwner(records, ownerOf, titles) {
    const byUser = new Map();
    for (const record of records) {
        const header = isObject(record.header) ? record.header : undefined;
        const id = header !== undefined && typeof header.id === 'string' ? header.id : '';
        if (id === '')
            continue;
        const username = ownerOf(id);
        const entry = {
            id,
            createdAt: header !== undefined && typeof header.createdAt === 'number' ? header.createdAt : 0,
            live: record.live === true,
            persisted: record.persisted === true,
        };
        if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '')
            entry.cwd = header.cwd;
        const title = titles?.get(id);
        if (title !== undefined && title !== '')
            entry.title = title;
        const bucket = byUser.get(username);
        if (bucket === undefined)
            byUser.set(username, [entry]);
        else
            bucket.push(entry);
    }
    const users = [];
    for (const [username, sessions] of byUser) {
        sessions.sort((a, b) => b.createdAt - a.createdAt);
        users.push({ username, sessions });
    }
    users.sort((a, b) => (b.sessions.length - a.sessions.length) || a.username.localeCompare(b.username));
    return users;
}
