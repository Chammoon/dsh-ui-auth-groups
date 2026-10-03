/**
 * 组存储（组 = 项目）。
 *
 * 数据模型：一个用户名可以属于多个组，一个组可以有多名成员；
 * 组是**只读共享**的边界 —— 成员能读彼此会话，写永远只属于会话归属人。
 *
 * 约定与上游保持一致：
 * - 落盘走 `ctx.get('fs')` 服务（与 `dsh-ui-auth-groups-sessions.json` 同处的工作目录）；
 * - 防抖写 + 卸载 flush，内存态是权威（读谓词是同步热路径，不能等 IO）；
 * - 损坏文件**隔离**成 `.corrupt-<ts>` 而不是静默丢弃；
 * - 读不到、解析失败、fs 服务缺席时一律视为「空组表」→ 读谓词 fail-closed，
 *   故障绝不退化成「全员可读」。
 */
/** 组名与用户名的输入上限（防御性，前端另有校验）。 */
export const GROUP_NAME_MAX = 64;
export const MEMBER_NAME_MAX = 64;
const MEMBERS_MAX = 500;
const FILE = 'dsh-ui-auth-groups-groups.json';
const SAVE_DEBOUNCE_MS = 200;
/** 组名非空、去首尾空白、限长。 */
export function normalizeGroupName(name) {
    const text = typeof name === 'string' ? name.trim() : '';
    if (text === '')
        throw new Error('group name must not be empty');
    if (text.length > GROUP_NAME_MAX)
        throw new Error(`group name must be at most ${GROUP_NAME_MAX} characters`);
    return text;
}
/** 成员名清洗：去空白与重复，丢弃空串。 */
function normalizeMembers(members) {
    if (!Array.isArray(members))
        return [];
    const seen = new Set();
    for (const raw of members) {
        if (typeof raw !== 'string')
            continue;
        const name = raw.trim();
        if (name === '' || name.length > MEMBER_NAME_MAX)
            continue;
        seen.add(name);
        if (seen.size >= MEMBERS_MAX)
            break;
    }
    return [...seen];
}
export class GroupStore {
    fs;
    groups = new Map();
    /** username -> groupIds；读谓词热路径用，避免每次遍历全部组。 */
    index = new Map();
    loaded = false;
    saveTimer;
    saving = Promise.resolve();
    constructor(fs) {
        this.fs = fs;
    }
    /** 从磁盘装载。失败/损坏一律落成空表（fail-closed），并隔离损坏文件。 */
    async load() {
        if (this.loaded)
            return;
        const fs = this.fs();
        if (fs === undefined)
            return; // fs 服务尚未就绪：保持空表，之后首次写操作会重试
        let text;
        try {
            const target = await fs.resolve(FILE);
            text = await fs.readText(target);
        }
        catch {
            this.loaded = true; // 文件不存在 = 全新部署
            return;
        }
        let parsed;
        try {
            const value = JSON.parse(text);
            if (value !== null && typeof value === 'object' && Array.isArray(value.groups)) {
                parsed = { v: 1, groups: value.groups };
            }
        }
        catch { /* 下面统一按损坏处理 */ }
        if (parsed === undefined) {
            await this.quarantine(fs, text);
            this.loaded = true;
            return;
        }
        for (const record of parsed.groups) {
            if (record === null || typeof record !== 'object')
                continue;
            if (typeof record.id !== 'string' || record.id === '')
                continue;
            let name;
            try {
                name = normalizeGroupName(record.name);
            }
            catch {
                continue;
            }
            const group = {
                id: record.id,
                name,
                members: normalizeMembers(record.members),
                createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
                updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
            };
            this.put(group);
        }
        this.loaded = true;
    }
    /** 损坏文件隔离：写一份 `.corrupt-<ts>` 供人工取证，原文件不再被复用。 */
    async quarantine(fs, text) {
        console.error('[dsh-ui-auth-groups] 组文件无法解析，已隔离为 .corrupt 副本并重置为空组表');
        try {
            const target = await fs.resolve(`${FILE}.corrupt-${Date.now()}`);
            await fs.writeText(target, text);
        }
        catch { /* 取证副本尽力而为 */ }
    }
    /** 写入内存索引（唯一入口，保证 groups 与 index 一致）。 */
    put(group) {
        const previous = this.groups.get(group.id);
        if (previous !== undefined) {
            for (const member of previous.members)
                this.detach(member, group.id);
        }
        this.groups.set(group.id, group);
        for (const member of group.members) {
            let set = this.index.get(member);
            if (set === undefined) {
                set = new Set();
                this.index.set(member, set);
            }
            set.add(group.id);
        }
    }
    detach(member, groupId) {
        const set = this.index.get(member);
        if (set === undefined)
            return;
        set.delete(groupId);
        if (set.size === 0)
            this.index.delete(member);
    }
    /**
     * 读谓词核心：`viewer` 与 `owner` 是否至少同属一个组。
     *
     * 同步、O(min(|A|,|B|))。任何异常路径返回 false（fail-closed）。
     */
    shares(viewer, owner) {
        if (viewer === '' || owner === '' || viewer === owner)
            return false;
        const a = this.index.get(viewer);
        if (a === undefined || a.size === 0)
            return false;
        const b = this.index.get(owner);
        if (b === undefined || b.size === 0)
            return false;
        const [small, large] = a.size <= b.size ? [a, b] : [b, a];
        for (const id of small) {
            if (large.has(id))
                return true;
        }
        return false;
    }
    list() {
        return [...this.groups.values()].sort((x, y) => x.name.localeCompare(y.name));
    }
    get(id) {
        return this.groups.get(id);
    }
    /** 某用户所在的全部组（面板用）。 */
    groupsOf(username) {
        const ids = this.index.get(username);
        if (ids === undefined)
            return [];
        const out = [];
        for (const id of ids) {
            const group = this.groups.get(id);
            if (group !== undefined)
                out.push(group);
        }
        return out.sort((x, y) => x.name.localeCompare(y.name));
    }
    create(input) {
        const name = normalizeGroupName(input.name);
        if (this.list().some(group => group.name === name))
            throw new Error(`group name already exists: ${name}`);
        const now = Date.now();
        const record = {
            id: globalThis.crypto.randomUUID(),
            name,
            members: normalizeMembers(input.members),
            createdAt: now,
            updatedAt: now,
        };
        this.put(record);
        this.scheduleSave();
        return record;
    }
    rename(id, name) {
        const record = this.require(id);
        const next = normalizeGroupName(name);
        if (this.list().some(group => group.name === next && group.id !== id)) {
            throw new Error(`group name already exists: ${next}`);
        }
        const updated = { ...record, name: next, updatedAt: Date.now() };
        this.put(updated);
        this.scheduleSave();
        return updated;
    }
    /** 覆盖式设置成员（管理员的成员增删改查都走这里，语义最不容易出错）。 */
    setMembers(id, members) {
        const record = this.require(id);
        const updated = { ...record, members: normalizeMembers(members), updatedAt: Date.now() };
        this.put(updated);
        this.scheduleSave();
        return updated;
    }
    remove(id) {
        const record = this.require(id);
        for (const member of record.members)
            this.detach(member, id);
        this.groups.delete(id);
        this.scheduleSave();
    }
    /** 用户被删除时从所有组里摘除（调用方负责在账户删除流程里调用）。 */
    removeMemberEverywhere(username) {
        let touched = 0;
        const ids = [...(this.index.get(username) ?? [])];
        for (const id of ids) {
            const record = this.groups.get(id);
            if (record === undefined)
                continue;
            const updated = { ...record, members: record.members.filter(m => m !== username), updatedAt: Date.now() };
            this.put(updated);
            touched += 1;
        }
        if (touched > 0)
            this.scheduleSave();
        return touched;
    }
    require(id) {
        const record = this.groups.get(String(id));
        if (record === undefined)
            throw new Error(`group not found: ${id}`);
        return record;
    }
    scheduleSave() {
        if (this.saveTimer !== undefined)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saving = this.writeNow();
        }, SAVE_DEBOUNCE_MS);
    }
    async writeNow() {
        const fs = this.fs();
        if (fs === undefined)
            return;
        const state = { v: 1, groups: this.list() };
        try {
            const target = await fs.resolve(FILE);
            await fs.writeText(target, `${JSON.stringify(state, null, 2)}\n`);
        }
        catch (err) {
            console.error('[dsh-ui-auth-groups] 写入组文件失败: ' + String(err));
        }
    }
    /** 强制落盘（卸载/更新时调用）。 */
    async flush() {
        if (this.saveTimer !== undefined) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        await this.saving;
        if (this.loaded)
            await this.writeNow();
    }
    /** 仅供测试与探针：内存态快照。 */
    snapshot() {
        return { v: 1, groups: this.list() };
    }
}
export default GroupStore;
