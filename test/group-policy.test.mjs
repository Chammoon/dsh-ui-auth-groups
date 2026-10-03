/**
 * 会话/工作区权限矩阵（二开：B1 组工作区 + B3 工作区绑定组 + 无组=私有）。
 *
 * 需求模型：
 *   仅本人可写 / 对象所属组的组内成员可读 / 管理员可读（管理员对他人会话不可写）
 *   无组 = 私有：仅本人 + 管理员可读
 *
 * 覆盖：读放行、写收紧、建会话落点、工作区管理权、列表与工作区投影、事件帧、
 * 建会话/fork 的绑定冻结、fail-closed、未接线时与上游一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModernPolicy } from '../lib/modern-policy.js'

const alice = { username: 'alice', role: 'user' }
const bob = { username: 'bob', role: 'user' }
const carol = { username: 'carol', role: 'user' }
const root = { username: 'root', role: 'admin' }

/**
 * 场景：
 * - 组 g1 = {alice, bob}，组 g2 = {carol}；
 * - 私有空间：wp-a(alice) / wp-b(bob) / wr(root)；
 * - 组工作区：wg1(g1) / wg2(g2)；
 * - 会话：a(alice, wp-a, 无组) / b(bob, wp-b, 无组) / s1(alice, wg1, g1)
 *        / s2(carol, wg2, g2) / r(root, wr, 无组) / orphan(未登记 = admin, 无组)。
 */
const sessionOwner = { a: 'alice', b: 'bob', s1: 'alice', s1b: 'bob', s2: 'carol', r: 'root' }
const workspaceOwner = { 'wp-a': 'alice', 'wp-b': 'bob', wg1: 'admin', wg2: 'admin', wr: 'root' }
const workspaceGroup = { wg1: 'g1', wg2: 'g2' }
const sessionGroup = { s1: 'g1', s1b: 'g1', s2: 'g2' }
const sessionWorkspace = { a: 'wp-a', b: 'wp-b', s1: 'wg1', s1b: 'wg1', s2: 'wg2', r: 'wr' }
const groupMembers = { g1: ['alice', 'bob'], g2: ['carol'] }

const owners = {
  session: (id) => sessionOwner[id] ?? 'admin',
  workspace: (id) => workspaceOwner[id] ?? 'admin',
  sessionGroup: (id) => sessionGroup[id],
  sessionWorkspace: (id) => sessionWorkspace[id],
  workspaceGroup: (id) => workspaceGroup[id],
  isMember: (username, groupId) => (groupMembers[groupId] ?? []).includes(username),
  sessionExists: async (id) => id !== 'brand-new',
  claimSession: async () => {},
  bindSession: async () => {},
}

const policy = createModernPolicy(owners)
/** 未接线组功能时（等于上游行为：一切都是私有的）。 */
const baseline = createModernPolicy({
  ...owners,
  sessionGroup: () => undefined,
  workspaceGroup: () => undefined,
  isMember: () => false,
})
const request = (value) => ({ args: { request: value } })
const correlation = () => ({ events: new Set() })

// ── 读：对象所属组 ──

test('读：组工作区里的会话对组内成员可读（page / follow / 文件预览）', async () => {
  assert.equal(await policy.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 's1' } })), true)
  assert.equal(await policy.authorize(bob, 'session/follow', request({ address: { kind: 'session', sessionId: 's1' } }), true), true)
  assert.equal(await policy.authorize(bob, 'workspaceFiles/read', { args: { workspaceFileScopeId: 's1' } }), true)
  assert.equal(await policy.authorize(bob, 'workspaceFiles/changes', { args: { workspaceFileScopeId: 's1' } }, true), true)
  assert.equal(await policy.authorize(bob, 'officeToPdf/render', { args: { workspaceFileScopeId: 's1' } }), true)
  // 自己的照旧
  assert.equal(await policy.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'a' } })), true)
})

test('读：无组 = 私有 —— 同组成员也读不到私有空间里的会话', async () => {
  // alice 与 bob 同组，但 a/b 建在各自的私有空间里（无组绑定）
  assert.equal(await policy.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'b' } })), false)
  assert.equal(await policy.authorize(bob, 'session/page', request({ address: { kind: 'session', sessionId: 'a' } })), false)
  assert.equal(await policy.authorize(alice, 'workspaceFiles/read', { args: { workspaceFileScopeId: 'b' } }), false)
  assert.equal(await policy.authorize(alice, 'skills/list', request({ sessionId: 'b' })), false)
})

test('读：非组员完全看不到组会话（不是「看得到打不开」）', async () => {
  assert.equal(await policy.authorize(carol, 'session/page', request({ address: { kind: 'session', sessionId: 's1' } })), false)
  assert.equal(await policy.authorize(carol, 'session/follow', request({ address: { kind: 'session', sessionId: 's1' } }), true), false)
  assert.equal(await policy.authorize(carol, 'workspaceFiles/read', { args: { workspaceFileScopeId: 's1' } }), false)
  assert.equal(await policy.authorize(carol, 'session/page', request({ address: { kind: 'session', sessionId: 's2' } })), true)
})

test('读：未登记的会话（owner=admin）对普通用户不可见', async () => {
  assert.equal(await policy.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'orphan' } })), false)
  assert.equal(await policy.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'nope' } })), false)
})

// ── 写：仅本人（管理员也不例外） ──

test('写：组员不能写对方会话（prompt/cancel/rename/fork/updateQueue/attachment/selectModel）', async () => {
  for (const method of ['prompt', 'attachment', 'cancel', 'rename', 'selectModel', 'updateQueue', 'fork']) {
    assert.equal(await policy.authorize(bob, `session/${method}`, request({ sessionId: 's1' })), false, `bob 不应能 session/${method} alice 的组会话`)
    assert.equal(await policy.authorize(alice, `session/${method}`, request({ sessionId: 's1' })), true, `alice 应能 session/${method} 自己的会话`)
  }
})

test('写：管理员对他人会话只读，对自己会话可写', async () => {
  assert.equal(await policy.authorize(root, 'session/page', request({ address: { kind: 'session', sessionId: 's1' } })), true)
  assert.equal(await policy.authorize(root, 'session/prompt', request({ sessionId: 's1' })), false)
  assert.equal(await policy.authorize(root, 'session/cancel', request({ sessionId: 'a' })), false)
  assert.equal(await policy.authorize(root, 'session/prompt', request({ sessionId: 'r' })), true)
})

test('写：组内共享不放宽「作答 / 目标 / 上传 / 归档 / 会话反馈」', async () => {
  assert.equal(await policy.authorize(bob, 'userQuestions/answer', { args: { sessionId: 's1', answer: 'x' } }), false)
  assert.equal(await policy.authorize(bob, 'goals/create', { args: { agentId: 's1' } }), false)
  assert.equal(await policy.authorize(bob, 'fileUploads/upload', { args: { agentId: 's1' } }), false)
  assert.equal(await policy.authorize(bob, 'workspace/archiveSession', request({ sessionId: 's1' })), false)
  assert.equal(await policy.authorize(bob, 'sessionFeedback/record', request({ sessionId: 's1' })), false)
  // 只读面仍放行，否则查看体验会碎
  assert.equal(await policy.authorize(bob, 'userQuestions/attachWait', { args: { sessionId: 's1' } }), true)
  assert.equal(await policy.authorize(bob, 'agentPresets/read', { args: { agentId: 's1' } }), true)
  assert.equal(await policy.authorize(bob, 'agentPresets/select', { args: { agentId: 's1', agentPreset: 'p' } }), false)
})

// ── 建会话落点：私有空间 / 组工作区 ──

test('建会话：自己的私有空间与所在组的组工作区都可以，别处不行', async () => {
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'wp-a' })), true)
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'wg1' })), true)
  assert.equal(await policy.authorize(bob, 'session/create', request({ workspaceId: 'wg1' })), true)
  // 别人的私有空间 / 别的组的组工作区 / 未知工作区
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'wp-b' })), false)
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'wg2' })), false)
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'ghost' })), false)
  // 客户端不能自带 cwd 绕开工作区
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'wp-a', cwd: '/tmp/x' })), false)
  // 管理员保留部署能力（cwd 建会话）
  assert.equal(await policy.authorize(root, 'session/create', request({ cwd: '/srv/x' })), true)
})

// ── 工作区管理权 ──

test('工作区：组员能用组工作区建会话，但不能改名/删除/改工作区顺序', async () => {
  assert.equal(await policy.authorize(bob, 'workspace/rename', request({ workspaceId: 'wg1', name: 'x' })), false)
  assert.equal(await policy.authorize(bob, 'workspace/delete', request({ workspaceId: 'wg1' })), false)
  assert.equal(await policy.authorize(bob, 'workspace/insertBefore', request({ workspaceId: 'wg1' })), false)
  // 会话在自己的组工作区里排序属于正常操作（bob 在 wg1 里自己的会话）
  assert.equal(await policy.authorize(bob, 'workspace/insertSessionBefore', request({ workspaceId: 'wg1', sessionId: 's1b' })), true)
  assert.equal(await policy.authorize(bob, 'workspace/insertSessionBefore', request({ workspaceId: 'wg1', sessionId: 's1' })), false)
  // 自己的私有空间照旧全权
  assert.equal(await policy.authorize(alice, 'workspace/rename', request({ workspaceId: 'wp-a', name: 'x' })), true)
  assert.equal(await policy.authorize(root, 'workspace/rename', request({ workspaceId: 'wg1', name: 'x' })), true)
})

// ── 投影：列表 / 工作区 / 事件帧 ──

test('会话列表投影：组会话可见，私有与组外会话被裁掉', async () => {
  const value = { items: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 's1' }, { sessionId: 's2' }, { sessionId: 'r' }] }
  const mine = await policy.result(alice, 'session/list', value)
  assert.deepEqual(mine.items.map((i) => i.sessionId), ['a', 's1'])
  const other = await policy.result(carol, 'session/list', value)
  assert.deepEqual(other.items.map((i) => i.sessionId), ['s2'])
  const all = await policy.result(root, 'session/list', value)
  assert.deepEqual(all.items.map((i) => i.sessionId), ['a', 'b', 's1', 's2', 'r'])
})

test('工作区投影：私有空间 + 组工作区出现在侧栏，别处的被裁掉', async () => {
  const frame = {
    type: 'baseline',
    value: {
      items: [
        { workspaceId: 'wp-a', sessionIds: ['a'] },
        { workspaceId: 'wp-b', sessionIds: ['b'] },
        { workspaceId: 'wg1', sessionIds: ['s1'] },
        { workspaceId: 'wg2', sessionIds: ['s2'] },
      ],
      archivedSessionIds: ['a', 'b', 's1', 's2'],
    },
  }
  const projected = policy.frame(alice, 'workspace/follow', frame, correlation())
  assert.deepEqual(projected.value.items.map((i) => i.workspaceId), ['wp-a', 'wg1'])
  assert.deepEqual(projected.value.items[1].sessionIds, ['s1'])
  assert.deepEqual(projected.value.archivedSessionIds, ['a', 's1'])
})

test('事件帧：组会话的活动帧投递，私有/组外的被抑制（返回 null）', () => {
  const frame = { type: 'waterfall', agentId: 's1', eventId: 'e1' }
  assert.equal(policy.frame(bob, '$events', frame, correlation()), frame)
  assert.equal(policy.frame(carol, '$events', frame, correlation()), null)
  const privateFrame = { type: 'waterfall', agentId: 'a', eventId: 'e2' }
  assert.equal(policy.frame(bob, '$events', privateFrame, correlation()), null)
  const status = { type: 'emit', event: 'api-session/status', args: ['s1'] }
  assert.equal(policy.frame(bob, '$events', status, correlation()), status)
  assert.equal(policy.frame(carol, '$events', status, correlation()), null)
})

// ── 绑定：建会话 / fork 冻结工作区与组 ──

test('result：在组工作区建会话 → 冻结为组会话；在私有空间建 → 无组', async () => {
  const bound = []
  const claiming = []
  const tracer = createModernPolicy({
    ...owners,
    claimSession: async (id, username) => { claiming.push([id, username]) },
    bindSession: async (id, workspaceId, groupId) => { bound.push([id, workspaceId, groupId]) },
  })
  await tracer.result(bob, 'session/create', { sessionId: 'new-1' }, { args: { request: { workspaceId: 'wg1' } } })
  assert.deepEqual(bound[0], ['new-1', 'wg1', 'g1'])
  assert.deepEqual(claiming[0], ['new-1', 'bob'])
  await tracer.result(alice, 'session/create', { sessionId: 'new-2' }, { args: { request: { workspaceId: 'wp-a' } } })
  assert.deepEqual(bound[1], ['new-2', 'wp-a', undefined])
  // 缺 payload（老宿主/异常调用）：只认领归属，不猜测组 → 私有
  await tracer.result(alice, 'session/create', { sessionId: 'new-3' })
  assert.deepEqual(bound[2], ['new-3', undefined, undefined])
})

test('result：fork 继承源会话的工作区与组（源会话不因后续改绑漂移）', async () => {
  const bound = []
  const tracer = createModernPolicy({
    ...owners,
    claimSession: async () => {},
    bindSession: async (id, workspaceId, groupId) => { bound.push([id, workspaceId, groupId]) },
  })
  await tracer.result(bob, 'session/fork', { sessionId: 'fork-1' }, { args: { request: { sessionId: 's1' } } })
  assert.deepEqual(bound[0], ['fork-1', 'wg1', 'g1'])
  await tracer.result(alice, 'session/fork', { sessionId: 'fork-2' }, { args: { request: { sessionId: 'a' } } })
  assert.deepEqual(bound[1], ['fork-2', 'wp-a', undefined])
})

// ── fail-closed 与兼容 ──

test('fail-closed：组查询抛错 → 无组（私有），绝不退化成组内可读', async () => {
  const broken = createModernPolicy({
    ...owners,
    sessionGroup: () => { throw new Error('store unavailable') },
    workspaceGroup: () => { throw new Error('store unavailable') },
    isMember: () => { throw new Error('store unavailable') },
  })
  assert.equal(await broken.authorize(bob, 'session/page', request({ address: { kind: 'session', sessionId: 's1' } })), false)
  assert.equal(await broken.authorize(bob, 'workspaceFiles/read', { args: { workspaceFileScopeId: 's1' } }), false)
  assert.equal(await broken.authorize(bob, 'session/create', request({ workspaceId: 'wg1' })), false)
  const listed = await broken.result(bob, 'session/list', { items: [{ sessionId: 'b' }, { sessionId: 's1' }] })
  assert.deepEqual(listed.items.map((i) => i.sessionId), ['b'])
  // 失败路径也要保留自己的东西
  assert.equal(await broken.authorize(bob, 'session/prompt', request({ sessionId: 'b' })), true)
})

test('未接线组功能时行为与上游一致（一切都是私有的）', async () => {
  // s2 是 carol 的组会话：没有组表时 alice 读不到
  assert.equal(await baseline.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 's2' } })), false)
  assert.equal(await baseline.authorize(alice, 'session/prompt', request({ sessionId: 'a' })), true)
  assert.equal(await baseline.authorize(alice, 'session/prompt', request({ sessionId: 's2' })), false)
  assert.equal(await baseline.authorize(alice, 'session/create', request({ workspaceId: 'wg1' })), false)
})
