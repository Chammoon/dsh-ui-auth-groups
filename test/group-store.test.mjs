/**
 * 组存储单元测试：成员关系（isMember）、跨用户可见性、fail-closed、损坏隔离、账户删除联动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GroupStore, normalizeGroupName } from '../lib/group-store.js'

/** 内存版 fs 服务，形状与 ctx.get('fs') 一致。 */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    async resolve(name) {
      return name
    },
    async readText(path) {
      if (!files.has(path)) throw new Error('ENOENT')
      return files.get(path)
    },
    async writeText(path, text) {
      files.set(path, text)
    },
  }
}

const FILE = 'dsh-ui-auth-groups-groups.json'

test('组名规范化：去空白、拒绝空与超长', () => {
  assert.equal(normalizeGroupName('  项目 A  '), '项目 A')
  assert.throws(() => normalizeGroupName('   '), /must not be empty/)
  assert.throws(() => normalizeGroupName('x'.repeat(65)), /at most/)
})

test('成员判定：一个用户可属于多个组，跨组不相通', async () => {
  const store = new GroupStore(() => memoryFs())
  await store.load()
  const a = store.create({ name: '项目 A', members: ['alice', 'bob'] })
  const b = store.create({ name: '项目 B', members: ['alice', 'carol'] })

  // alice 同时在 A、B 两个组
  assert.deepEqual(store.groupsOf('alice').map((g) => g.name), ['项目 A', '项目 B'])
  assert.deepEqual(store.groupIdsOf('alice').sort(), [a.id, b.id].sort())
  assert.equal(store.isMember('alice', a.id), true)
  assert.equal(store.isMember('alice', b.id), true)
  assert.equal(store.isMember('bob', a.id), true)
  // 跨组不相通：bob 不在 B、carol 不在 A
  assert.equal(store.isMember('bob', b.id), false)
  assert.equal(store.isMember('carol', a.id), false)
  // 不在任何组里的用户 / 非法 id
  assert.equal(store.isMember('dave', a.id), false)
  assert.equal(store.isMember('alice', ''), false)
  assert.equal(store.isMember('', a.id), false)
  assert.equal(store.isMember('alice', 'no-such-group'), false)
  assert.deepEqual(store.groupIdsOf('dave'), [])
})

test('成员增删改查立即影响可见性', async () => {
  const store = new GroupStore(() => memoryFs())
  await store.load()
  const group = store.create({ name: '项目 A', members: ['alice'] })
  assert.equal(store.isMember('bob', group.id), false)

  store.setMembers(group.id, ['alice', 'bob'])
  assert.equal(store.isMember('bob', group.id), true)

  store.setMembers(group.id, ['alice'])
  assert.equal(store.isMember('bob', group.id), false)

  // 重复成员与空串会被清洗
  const again = store.setMembers(group.id, ['alice', 'alice', '', '  '])
  assert.deepEqual(again.members, ['alice'])
})

test('账户删除：从所有组里摘除', async () => {
  const store = new GroupStore(() => memoryFs())
  await store.load()
  store.create({ name: '项目 A', members: ['alice', 'bob'] })
  store.create({ name: '项目 B', members: ['bob', 'carol'] })

  assert.equal(store.removeMemberEverywhere('bob'), 2)
  assert.equal(store.isMember('bob', store.list()[0].id), false)
  assert.equal(store.isMember('bob', store.list()[1].id), false)
  assert.deepEqual(store.groupIdsOf('bob'), [])
  assert.deepEqual(store.groupsOf('bob'), [])
})

test('落盘与重载：成员关系跨重启存活', async () => {
  const fs = memoryFs()
  const first = new GroupStore(() => fs)
  await first.load()
  first.create({ name: '项目 A', members: ['alice', 'bob'] })
  await first.flush()
  assert.ok(fs.files.has(FILE), '应写出组文件')

  const second = new GroupStore(() => fs)
  await second.load()
  assert.equal(second.list().length, 1)
  assert.equal(second.isMember('alice', second.list()[0].id), true)
  assert.equal(second.isMember('bob', second.list()[0].id), true)
  assert.equal(second.isMember('carol', second.list()[0].id), false)
})

test('fail-closed：fs 不可用 / 文件缺失时是空组表，绝不误判为成员', async () => {
  const noFs = new GroupStore(() => undefined)
  await noFs.load()
  assert.equal(noFs.isMember('alice', 'g1'), false)

  const emptyFs = new GroupStore(() => memoryFs())
  await emptyFs.load()
  assert.equal(emptyFs.isMember('alice', 'g1'), false)
  assert.deepEqual(emptyFs.groupIdsOf('alice'), [])
})

test('fail-closed：损坏文件被隔离成 .corrupt 副本并重置为空组表', async () => {
  const fs = memoryFs({ [FILE]: '{ not json' })
  const store = new GroupStore(() => fs)
  await store.load()

  assert.deepEqual(store.list(), [])
  assert.equal(store.isMember('alice', 'g1'), false)
  const quarantined = [...fs.files.keys()].filter((key) => key.startsWith(`${FILE}.corrupt-`))
  assert.equal(quarantined.length, 1, '应保留一份取证副本')
  assert.equal(fs.files.get(quarantined[0]), '{ not json')
})

test('组名唯一（含改名）', async () => {
  const store = new GroupStore(() => memoryFs())
  await store.load()
  const a = store.create({ name: '项目 A' })
  const b = store.create({ name: '项目 B' })
  assert.throws(() => store.create({ name: '项目 A' }), /already exists/)
  assert.throws(() => store.rename(b.id, '项目 A'), /already exists/)
  assert.equal(store.rename(b.id, '项目 C').name, '项目 C')
  assert.equal(store.get(a.id).name, '项目 A')
})

test('删除组后成员关系一并清理', async () => {
  const store = new GroupStore(() => memoryFs())
  await store.load()
  const group = store.create({ name: '项目 A', members: ['alice', 'bob'] })
  store.remove(group.id)
  assert.equal(store.isMember('alice', group.id), false)
  assert.equal(store.isMember('bob', group.id), false)
  assert.deepEqual(store.groupsOf('alice'), [])
  assert.throws(() => store.remove(group.id), /not found/)
})
