/**
 * 会话转录提取测试。事件形状取自真实会话日志（DSH 0.2.x session.v4.jsonl）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, foldTitle, groupByOwner, readUserMessage, textOfBlocks } from '../lib/session-transcript.js'

/** 真人输入（真实形状）。 */
const userEvent = (seq, text, kind = 'user') => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { content: [{ type: 'text', text }], source: { kind, rpcId: 'r1' }, role: 'user', id: 'm' + seq },
  surfaceOp: 'append',
})

/** 助手回复（真实形状：text / reasoning / tool-call 混在 content 里）。 */
const assistantEvent = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: 1000 + seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '这是思考，不应出现在转录里' },
        { type: 'text', text },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
    },
  },
})

const titleEvent = (seq, title) => ({ type: 'session/title', seq, time: 1000 + seq, data: { title, messageSeqs: [1] } })

test('正文提取：只取 text 块，跳过 reasoning 与 tool-call', () => {
  assert.equal(textOfBlocks([{ type: 'reasoning', text: 'a' }, { type: 'text', text: 'b' }, { type: 'tool-call' }]), 'b')
  assert.equal(textOfBlocks('not-array'), '')
  const read = readUserMessage(userEvent(1, '你好'))
  assert.deepEqual(read, { text: '你好', source: 'user' })
})

test('转录：用户与助手消息按 seq 排列，思考与工具调用不入内', () => {
  const transcript = buildTranscript([
    userEvent(1, '第一个问题'),
    assistantEvent(2, '第一段回答'),
    { type: 'tool/call', seq: 3, time: 1, data: {} },
    { type: 'tool/result', seq: 4, time: 1, data: {} },
    userEvent(5, '第二个问题'),
    assistantEvent(6, '第二段回答'),
  ])
  assert.deepEqual(transcript.messages.map((m) => [m.role, m.text]), [
    ['user', '第一个问题'],
    ['assistant', '第一段回答'],
    ['user', '第二个问题'],
    ['assistant', '第二段回答'],
  ])
  assert.equal(transcript.droppedMessages, 0)
  assert.equal(transcript.truncatedMessages, 0)
})

test('标题：从 session/title 事件折叠，取最新一条', () => {
  const events = [titleEvent(2, '旧标题'), userEvent(3, 'x'), titleEvent(9, '新标题')]
  assert.equal(foldTitle(events), '新标题')
  assert.equal(buildTranscript(events).title, '新标题')
  assert.equal(buildTranscript([userEvent(1, 'x')]).title, undefined)
})

test('注入上下文默认不算用户消息，可按需纳入', () => {
  const events = [
    userEvent(1, '真人说的'),
    userEvent(2, 'AGENTS.md 内容被注入', 'injected-context'),
  ]
  const strict = buildTranscript(events)
  assert.deepEqual(strict.messages.map((m) => m.text), ['真人说的'])
  const wide = buildTranscript(events, { includeInjected: true })
  assert.deepEqual(wide.messages.map((m) => [m.text, m.source]), [
    ['真人说的', 'user'],
    ['AGENTS.md 内容被注入', 'injected-context'],
  ])
})

test('超长会话：从最新往回保留 maxMessages 条并如实报告丢弃数', () => {
  const events = []
  for (let i = 0; i < 20; i += 1) events.push(userEvent(i * 2 + 1, 'q' + i), assistantEvent(i * 2 + 2, 'a' + i))
  const transcript = buildTranscript(events, { maxMessages: 5 })
  assert.equal(transcript.messages.length, 5)
  assert.equal(transcript.droppedMessages, 35)
  assert.equal(transcript.messages[transcript.messages.length - 1].text, 'a19')
  // 40 条里保留末 5 条：a17, q18, a18, q19, a19
  assert.deepEqual(transcript.messages.map((m) => m.text), ['a17', 'q18', 'a18', 'q19', 'a19'])
})

test('单条超长正文按 maxTextChars 截断并标记', () => {
  const transcript = buildTranscript([userEvent(1, 'x'.repeat(50))], { maxTextChars: 10 })
  assert.equal(transcript.truncatedMessages, 1)
  assert.ok(transcript.messages[0].text.startsWith('x'.repeat(10)))
  assert.ok(transcript.messages[0].text.includes('已截断'))
})

test('按用户分组：归属、排序、未登记按 admin、标题旁路表', () => {
  const records = [
    { header: { id: 's1', createdAt: 100, cwd: '/p/a' }, live: true, persisted: true },
    { header: { id: 's2', createdAt: 300, cwd: '/p/b' }, live: false, persisted: true },
    { header: { id: 's3', createdAt: 200 }, live: false, persisted: true },
    { header: { id: 's4', createdAt: 400 }, live: true, persisted: false },
  ]
  const owners = { s1: 'alice', s2: 'bob', s3: 'bob', s4: 'alice' }
  // 未登记的会话按上游语义归 admin
  const users = groupByOwner(records, (id) => owners[id] ?? 'admin', new Map([['s2', '鲍勃的会话']]))
  assert.deepEqual(users.map((u) => [u.username, u.sessions.length]), [['alice', 2], ['bob', 2]])
  // 每个用户内部按创建时间倒序
  assert.deepEqual(users[0].sessions.map((s) => s.id), ['s4', 's1'])
  assert.deepEqual(users[1].sessions.map((s) => s.id), ['s2', 's3'])
  // 标题与元数据
  assert.equal(users[1].sessions[0].title, '鲍勃的会话')
  assert.equal(users[0].sessions[1].cwd, '/p/a')
  assert.equal(users[0].sessions[1].live, true)

  const orphan = groupByOwner([{ header: { id: 's9', createdAt: 1 } }], () => 'admin')
  assert.deepEqual(orphan.map((u) => u.username), ['admin'])
})

test('畸形输入不抛错（防御性）', () => {
  assert.deepEqual(buildTranscript([null, 42, {}, { type: 'user/message' }]).messages, [])
  assert.deepEqual(groupByOwner([{ header: {} }, { header: { id: 7 } }, {}], () => 'x'), [])
})
