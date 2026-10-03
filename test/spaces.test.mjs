/**
 * 私有空间 / 组工作区供给的单元测试。
 *
 * 重点：目录推导的路径穿越防护（用户名/组名来自用户输入）、幂等复用、
 * 宿主注册表缺席时的显式失败（绝不静默降级）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  SEGMENT_MAX,
  SpaceProvisioner,
  listSpaceWorkspaces,
  readSpaceConfig,
  safeSegment,
  spaceWorkspaceOf,
  workspaceSegment,
} from '../lib/spaces.js'

/** 内存版宿主注册表：按 canonical path 去重，与 DSH WorkspaceRegistry.create 语义一致。 */
function memoryRegistry() {
  const byPath = new Map()
  let next = 0
  return {
    byPath,
    async create(path, title) {
      const key = path.replace(/\/+$/, '')
      const existing = byPath.get(key)
      if (existing !== undefined) return existing
      next += 1
      const record = { id: 'ws-' + next, path: key, title: title ?? key.split('/').pop() }
      byPath.set(key, record)
      return record
    },
    get(id) {
      for (const record of byPath.values()) if (record.id === id) return record
      return undefined
    },
    list() {
      return [...byPath.values()]
    },
  }
}

/** 组装一个可观测的供给器（记录 mkdir/claim/bind/remember 调用）。 */
function harness(options = {}) {
  const registry = 'registry' in options ? options.registry : memoryRegistry()
  const calls = { mkdir: [], claim: [], bind: [], remember: [] }
  const privateIds = new Map()
  const provisioner = new SpaceProvisioner({
    registry,
    root: options.root ?? '/srv/spaces',
    mkdir: async (path) => { calls.mkdir.push(path) },
    claim: async (id, username) => { calls.claim.push([id, username]) },
    bindGroup: async (id, groupId) => { calls.bind.push([id, groupId]) },
    rememberPrivate: async (username, id) => { privateIds.set(username, id); calls.remember.push([username, id]) },
    knownPrivate: (username) => privateIds.get(username),
    log: () => {},
  })
  return { provisioner, registry, calls, privateIds }
}

test('配置：默认 <DSH_HOME>/spaces，可覆盖，可关闭自动供给', () => {
  const fallback = readSpaceConfig({ DSH_HOME: '/home/alice/.dsh' })
  assert.equal(fallback.root, '/home/alice/.dsh/spaces')
  assert.equal(fallback.enabled, true)

  const custom = readSpaceConfig({ DSH_HOME: '/home/alice/.dsh', DSH_AUTH_WORKSPACES_DIR: '/data/spaces/' })
  assert.equal(custom.root, '/data/spaces')

  for (const flag of ['0', 'false', 'OFF', 'no']) {
    assert.equal(readSpaceConfig({ DSH_AUTH_PROVISION: flag }).enabled, false, flag)
  }
  assert.equal(readSpaceConfig({ DSH_AUTH_PROVISION: '1' }).enabled, true)
})

test('目录名清洗：保留 CJK/字母数字，剥掉分隔符与首尾点线，限长', () => {
  assert.equal(safeSegment('alice', 'user'), 'alice')
  assert.equal(safeSegment('项目 A', 'group'), '项目-A')
  assert.equal(safeSegment('../../etc/passwd', 'user'), 'etc-passwd')
  assert.equal(safeSegment('..', 'user'), 'user')
  assert.equal(safeSegment('.', 'user'), 'user')
  assert.equal(safeSegment('   ', 'user'), 'user')
  assert.equal(safeSegment('a/b\\c', 'user'), 'a-b-c')
  assert.equal(safeSegment('x'.repeat(120), 'user').length, SEGMENT_MAX)
  assert.equal(safeSegment(undefined, 'user'), 'user')
})

test('目录片段去重：不同用户名的清洗结果不会撞到同一目录', () => {
  // 普通用户名保持原样（路径可读）
  assert.equal(workspaceSegment('alice', 'user'), 'alice')
  assert.equal(workspaceSegment('Alice-01', 'user'), 'Alice-01')
  // 会被清洗成同一结果的输入必须带上去重后缀
  const weird = ['..', '--', '._', 'a b', 'a/b', '']
  const segments = weird.map((name) => workspaceSegment(name, 'user'))
  assert.equal(new Set(segments).size, segments.length, segments.join(','))
  // 每个都带 8 位去重后缀，且与「真的叫 user 的人」不冲突
  for (const segment of segments) assert.match(segment, /-[0-9a-f]{8}$/, segment)
  assert.ok(!segments.includes('user'), segments.join(','))
})

test('私有空间：建目录 → 注册 → 认领归属 → 记住映射', async () => {
  const { provisioner, calls, privateIds } = harness()
  const workspace = await provisioner.ensurePrivate('alice')

  assert.equal(workspace.path, '/srv/spaces/users/alice')
  assert.deepEqual(calls.mkdir, ['/srv/spaces/users/alice'])
  assert.deepEqual(calls.claim, [[workspace.id, 'alice']])
  assert.deepEqual(calls.remember, [['alice', workspace.id]])
  assert.equal(privateIds.get('alice'), workspace.id)
  // 私有空间不绑定任何组
  assert.deepEqual(calls.bind, [])
})

test('私有空间：重复调用复用同一个工作区（幂等，不重复建目录）', async () => {
  const { provisioner, calls, registry } = harness()
  const first = await provisioner.ensurePrivate('alice')
  const second = await provisioner.ensurePrivate('alice')
  assert.equal(first.id, second.id)
  // 命中 knownPrivate + 注册表仍在 → 不再跑目录/注册/写盘
  assert.equal(calls.mkdir.length, 1)
  assert.equal(calls.claim.length, 1)
  assert.equal(registry.list().length, 1)
})

test('私有空间：注册表里记录被删后重新供给（自愈）', async () => {
  const { provisioner, calls, registry } = harness()
  const first = await provisioner.ensurePrivate('alice')
  await registry.create('/somewhere/else') // 让注册表仍有内容，但不含 alice 的 id
  const store = registry.byPath.get('/srv/spaces/users/alice')
  assert.equal(store.id, first.id)
  registry.byPath.delete('/srv/spaces/users/alice')
  const again = await provisioner.ensurePrivate('alice')
  assert.equal(again.path, '/srv/spaces/users/alice')
  assert.equal(calls.mkdir.length, 2)
})

/** 目标路径必须严格落在 base 之下（相对路径不含 `..`、不是绝对路径）。 */
function assertInside(base, target) {
  const rel = relative(resolve(base), resolve(target))
  assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), `${target} 逃出了 ${base}`)
}

test('路径穿越：恶意用户名/组名都无法逃出 root', async () => {
  const { provisioner: pather } = harness()
  // 每个奇异用户名都落在各自独立、且在 root 之内的目录
  const seen = new Set()
  for (const username of ['..', '--', '..', '.']) {
    const path = pather.privatePath(username)
    assertInside('/srv/spaces/users', path)
    seen.add(path)
  }
  assert.equal(seen.size, 3, [...seen].join(','))
  const { provisioner } = harness()
  for (const username of ['..', '../..', '.', '../../etc', 'a/../../b', 'x/../../../../root']) {
    const path = provisioner.privatePath(username)
    assertInside('/srv/spaces/users', path)
  }
  const groupPath = provisioner.groupPath({ id: 'abcdef12-3456-7890-abcd-ef1234567890', name: '../../etc/passwd' })
  assertInside('/srv/spaces/groups', groupPath)
  assert.ok(groupPath.endsWith('abcdef12'), groupPath)
})

test('组工作区：目录带组名与 id 后缀，注册后绑定到组', async () => {
  const { provisioner, calls } = harness()
  const group = { id: '11112222-3333-4444-5555-666677778888', name: '项目 A' }
  const workspace = await provisioner.ensureGroup(group)
  assert.equal(workspace.path, '/srv/spaces/groups/项目-A-11112222')
  assert.deepEqual(calls.bind, [[workspace.id, group.id]])
  // 组工作区不认领个人归属，也不写私有映射
  assert.deepEqual(calls.claim, [])
  assert.deepEqual(calls.remember, [])
})

test('fail-closed：宿主没有 workspaceRegistry 时显式报错，不静默成功', async () => {
  const { provisioner } = harness({ registry: undefined })  // 显式缺席：宿主没有这个服务
  assert.equal(provisioner.available, false)
  await assert.rejects(() => provisioner.ensurePrivate('alice'), /workspaceRegistry/)
  await assert.rejects(() => provisioner.ensureGroup({ id: 'g1', name: '项目 A' }), /workspaceRegistry/)
})

test('建目录失败时把错误抛给调用方（面板要能提示）', async () => {
  const provisioner = new SpaceProvisioner({
    registry: memoryRegistry(),
    root: '/srv/spaces',
    mkdir: async () => { throw new Error('EACCES: permission denied') },
    claim: async () => {},
    bindGroup: async () => {},
    rememberPrivate: async () => {},
    knownPrivate: () => undefined,
  })
  await assert.rejects(() => provisioner.ensurePrivate('alice'), /EACCES/)
})

test('工作区实体形状：认可的字段提取，缺 id 一律拒绝', () => {
  assert.deepEqual(spaceWorkspaceOf({ id: 'w1', path: '/a/b', title: '项目' }), { id: 'w1', path: '/a/b', title: '项目' })
  assert.deepEqual(spaceWorkspaceOf({ id: 'w1' }), { id: 'w1', path: '', title: 'w1' })
  assert.equal(spaceWorkspaceOf({ path: '/a/b' }), undefined)
  assert.equal(spaceWorkspaceOf(null), undefined)
  assert.equal(spaceWorkspaceOf('w1'), undefined)
})

test('注册表投影：list 抛错或形状不对时回空表（不误报工作区）', () => {
  assert.deepEqual(listSpaceWorkspaces(undefined), [])
  assert.deepEqual(listSpaceWorkspaces({ create: async () => {} }), [])
  assert.deepEqual(listSpaceWorkspaces({ create: async () => {}, list: () => { throw new Error('boom') } }), [])
  assert.deepEqual(listSpaceWorkspaces({ create: async () => {}, list: () => 'nope' }), [])
  const listed = listSpaceWorkspaces({ create: async () => {}, list: () => [{ id: 'w1', path: '/a' }, { nope: 1 }] })
  assert.deepEqual(listed, [{ id: 'w1', path: '/a', title: 'w1' }])
})

test('根目录拼接使用平台分隔符（Windows 上同样成立）', () => {
  const provisioner = new SpaceProvisioner({
    registry: memoryRegistry(),
    root: sep === '\\' ? 'C:\\spaces' : '/srv/spaces',
    mkdir: async () => {},
    claim: async () => {},
    bindGroup: async () => {},
    rememberPrivate: async () => {},
    knownPrivate: () => undefined,
  })
  const path = provisioner.privatePath('alice')
  assert.ok(path.endsWith(sep + 'alice'), path)
  assert.ok(path.includes(sep + 'users' + sep), path)
})
