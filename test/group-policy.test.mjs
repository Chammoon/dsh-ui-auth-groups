/**
 * 组会话权限矩阵（二开新增）。
 *
 * 需求模型：
 *   仅本人可写 / 组内其他人可读 / 管理员可读
 *
 * 覆盖：读放行、写收紧、列表与工作区投影、事件帧、fail-closed、未接线时与上游一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModernPolicy } from '../lib/modern-policy.js'

const alice = { username: 'alice', role: 'user' }
const bob = { username: 'bob', role: 'user' }
const carol = { username: 'carol', role: 'user' }
const root = { username: 'root', role: 'admin' }

/** 会话/工作区归属：a/wa→alice，b/wb→bob，c/wc→carol，r/wr→root（管理员自己的）。 */
const ownerOf = (id) => {
  if (id === 'a' || id === 'wa') return 'alice'
  if (id === 'b' || id === 'wb') return 'bob'
  if (id === 'c' || id === 'wc') return 'carol'
  if (id === 'r' || id === 'wr') return 'root'
  return 'admin'
}
const owners = {
  session: ownerOf,
  workspace: ownerOf,
  sessionExists: async (id) => id !== 'new',
  claimSession: async () => {},
}
/** alice 与 bob 同组；carol 单独一组。 */
const sharesGroup = (viewer, owner) =>
  (viewer === 'alice' && owner === 'bob') || (viewer === 'bob' && owner === 'alice')

const policy = createModernPolicy(owners, { sharesGroup })
/** 未接线组功能时（等于上游行为）。 */
const baseline = createModernPolicy(owners)
const request = (value) => ({ args: { request: value } })
const correlation = () => ({ events: new Set() })

// ── 读：组内可读 ──

test('读：同组成员可读对方会话（page / follow / 文件预览）', async () => {
  assert.equal(await policy.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'b' } })), true)
  assert.equal(await policy.authorize(alice, 'session/follow', request({ address: { kind: 'session', sessionId: 'b' } }), true), true)
  assert.equal(await policy.authorize(alice, 'workspaceFiles/read', { args: { workspaceFileScopeId: 'b' } }), true)
  assert.equal(await policy.authorize(alice, 'workspaceFiles/changes', { args: { workspaceFileScopeId: 'b' } }, true), true)
  assert.equal(await policy.authorize(alice, 'officeToPdf/render', { args: { workspaceFileScopeId: 'b' } }), true)
  // 自己的照旧
  assert.equal(await policy.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'a' } })), true)
})

test('读：非组员完全看不到（不是「看得到打不开」）', async () => {
  assert.equal(await policy.authorize(carol, 'session/page', request({ address: { kind: 'session', sessionId: 'b' } })), false)
  assert.equal(await policy.authorize(carol, 'session/follow', request({ address: { kind: 'session', sessionId: 'b' } }), true), false)
  assert.equal(await policy.authorize(carol, 'workspaceFiles/read', { args: { workspaceFileScopeId: 'b' } }), false)
  assert.equal(await policy.authorize(carol, 'skills/list', request({ sessionId: 'b' })), false)
})

// ── 写：仅本人（管理员也不例外） ──

test('写：同组成员不能写对方会话（prompt/cancel/rename/fork/updateQueue/attachment/selectModel）', async () => {
  for (const method of ['prompt', 'attachment', 'cancel', 'rename', 'selectModel', 'updateQueue', 'fork']) {
    assert.equal(await policy.authorize(alice, `session/${method}`, request({ sessionId: 'b' })), false, `alice 不应能 session/${method} bob 的会话`)
    assert.equal(await policy.authorize(bob, `session/${method}`, request({ sessionId: 'b' })), true, `bob 应能 session/${method} 自己的会话`)
  }
})

test('写：管理员对他人会话只读，对自己会话可写', async () => {
  assert.equal(await policy.authorize(root, 'session/page', request({ address: { kind: 'session', sessionId: 'b' } })), true)
  assert.equal(await policy.authorize(root, 'session/prompt', request({ sessionId: 'b' })), false)
  assert.equal(await policy.authorize(root, 'session/cancel', request({ sessionId: 'b' })), false)
  assert.equal(await policy.authorize(root, 'session/prompt', request({ sessionId: 'r' })), true)
})

test('写：组内共享不放宽「作答 / 目标 / 上传 / 归档 / 工作区改写」', async () => {
  assert.equal(await policy.authorize(alice, 'userQuestions/answer', { args: { sessionId: 'b', answer: 'x' } }), false)
  assert.equal(await policy.authorize(alice, 'goals/create', { args: { agentId: 'b' } }), false)
  assert.equal(await policy.authorize(alice, 'fileUploads/upload', { args: { agentId: 'b' } }), false)
  assert.equal(await policy.authorize(alice, 'workspace/archiveSession', request({ sessionId: 'b' })), false)
  assert.equal(await policy.authorize(alice, 'workspace/rename', request({ workspaceId: 'wb', name: 'x' })), false)
  // 只读面仍放行，否则查看体验会碎
  assert.equal(await policy.authorize(alice, 'userQuestions/attachWait', { args: { sessionId: 'b' } }), true)
  assert.equal(await policy.authorize(alice, 'agentPresets/read', { args: { agentId: 'b' } }), true)
  assert.equal(await policy.authorize(alice, 'agentPresets/select', { args: { agentId: 'b', agentPreset: 'p' } }), false)
})

test('写：不能把会话建到别人的工作区', async () => {
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'wa' })), true)
  assert.equal(await policy.authorize(alice, 'session/create', request({ workspaceId: 'wb' })), false)
})

// ── 投影：列表 / 工作区 / 事件帧 ──

test('会话列表投影：组内会话可见，组外不可见', async () => {
  const value = { items: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }] }
  const mine = await policy.result(alice, 'session/list', value)
  assert.deepEqual(mine.items.map((i) => i.sessionId), ['a', 'b'])
  const other = await policy.result(carol, 'session/list', value)
  assert.deepEqual(other.items.map((i) => i.sessionId), ['c'])
  const all = await policy.result(root, 'session/list', value)
  assert.deepEqual(all.items.map((i) => i.sessionId), ['a', 'b', 'c'])
})

test('工作区投影：同组工作区与其会话出现在侧栏，组外的被裁掉', async () => {
  const frame = {
    type: 'baseline',
    value: {
      items: [
        { workspaceId: 'wa', sessionIds: ['a'] },
        { workspaceId: 'wb', sessionIds: ['b'] },
        { workspaceId: 'wc', sessionIds: ['c'] },
      ],
      archivedSessionIds: ['a', 'b', 'c'],
    },
  }
  const projected = policy.frame(alice, 'workspace/follow', frame, correlation())
  assert.deepEqual(projected.value.items.map((i) => i.workspaceId), ['wa', 'wb'])
  assert.deepEqual(projected.value.items[1].sessionIds, ['b'])
  assert.deepEqual(projected.value.archivedSessionIds, ['a', 'b'])
})

test('事件帧：同组会话的活动帧投递，组外的被抑制（返回 null）', () => {
  const frame = { type: 'waterfall', agentId: 'b', eventId: 'e1' }
  assert.equal(policy.frame(alice, '$events', frame, correlation()), frame)
  assert.equal(policy.frame(carol, '$events', frame, correlation()), null)
  const status = { type: 'emit', event: 'api-session/status', args: ['b'] }
  assert.equal(policy.frame(alice, '$events', status, correlation()), status)
  assert.equal(policy.frame(carol, '$events', status, correlation()), null)
})

// ── fail-closed 与兼容 ──

test('fail-closed：组查询抛错视为不同组，绝不退化成全员可读', async () => {
  const broken = createModernPolicy(owners, {
    sharesGroup: () => {
      throw new Error('store unavailable')
    },
  })
  assert.equal(await broken.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'b' } })), false)
  assert.equal(await broken.authorize(alice, 'workspaceFiles/read', { args: { workspaceFileScopeId: 'b' } }), false)
  const listed = await broken.result(alice, 'session/list', { items: [{ sessionId: 'a' }, { sessionId: 'b' }] })
  assert.deepEqual(listed.items.map((i) => i.sessionId), ['a'])
})

test('未接线组功能时行为与上游一致（同组概念不存在）', async () => {
  assert.equal(await baseline.authorize(alice, 'session/page', request({ address: { kind: 'session', sessionId: 'b' } })), false)
  assert.equal(await baseline.authorize(alice, 'session/prompt', request({ sessionId: 'a' })), true)
  assert.equal(await baseline.authorize(alice, 'session/prompt', request({ sessionId: 'b' })), false)
})
