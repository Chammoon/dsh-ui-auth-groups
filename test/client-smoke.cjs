// Smoke test: load lib/client.js through a mock of the client module loader,
// then run apply() against mock ctxs to verify:
//   - the settings.section「用户管理」registration path,
//   - the models-page lock for non-admin users (priority -1, nav-hide rule),
//   - button text color uses the on-primary token (readability regression guard).
const fs = require('fs')
const path = require('path')

const registrations = []
const mockReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
}

const window = {
  __ModuleLoader__: {
    load(reg) { registrations.push(reg) },
  },
}

// 路径必须相对本文件解析：CI（GitHub Actions）上没有作者本机的绝对路径。
const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
new Function('window', code)(window)

if (registrations.length !== 1) {
  console.error('FAIL: expected exactly 1 __ModuleLoader__.load registration, got', registrations.length)
  process.exit(1)
}
const reg = registrations[0]
console.log('registration id:', reg.id)

const seed = new Map(Object.entries({ 'react': mockReact }))
const exp = reg.factory((spec) => {
  if (seed.has(spec)) return seed.get(spec)
  throw new Error('require("' + spec + '") missed the module table')
})

if (exp.name !== 'dsh-ui-auth-groups' || typeof exp.apply !== 'function') {
  console.error('FAIL: bundle did not export the cordis plugin face')
  process.exit(1)
}

let failures = 0
function check(label, cond, extra) {
  if (cond) { console.log('PASS ' + label) } else { failures++; console.error('FAIL ' + label + (extra !== undefined ? ' :: ' + extra : '')) }
}

// ---- scenario helpers ----
function makeCtx() {
  const recorded = []
  const slots = {
    inject(key, cb) { cb() },
    register(opts, render) { recorded.push({ opts, render }) },
  }
  return {
    ctx: { get: (n) => (n === 'slots' ? slots : undefined) },
    recorded,
  }
}
function stubFetch(meJson) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => meJson,
  })
}
const tick = () => new Promise((r) => setTimeout(r, 20))

// ---- 1) ADMIN: auth-users only, models lock NOT registered ----
;(async () => {
  stubFetch({ ok: true, me: { username: 'admin', role: 'admin' } })
  const s1 = makeCtx()
  exp.apply(s1.ctx)
  await tick()
  check('admin: auth-users registered', s1.recorded.some((r) => r.opts.id === 'auth-users'))
  check('admin: models lock NOT registered', !s1.recorded.some((r) => r.opts.id === 'models'))
  check('admin: auth-shares registered', s1.recorded.some((r) => r.opts.id === 'auth-shares'))
  {
    const authReg = s1.recorded.find((r) => r.opts.id === 'auth-users')
    const inner = authReg.render().type()
    check('admin: auth-users renders dshua root', inner.props.className === 'dshua')
  }

  // ---- 2) USER: auth-users + models lock (priority -1) ----
  stubFetch({ ok: true, me: { username: 'test1', role: 'user' } })
  const s2 = makeCtx()
  exp.apply(s2.ctx)
  await tick()
  check('user: auth-users registered', s2.recorded.some((r) => r.opts.id === 'auth-users'))
  check('user: auth-shares NOT registered (admin-only)', !s2.recorded.some((r) => r.opts.id === 'auth-shares'))
  check('user: plugin-manager read-only guard present', code.includes('dshuaReadonly') && code.includes('仅部署者可以安装'))
  check('user: read-only guard skips the plugin\'s own DOM (.dshua)', code.includes('closest(".dshua")'))
  const modelsReg = s2.recorded.find((r) => r.opts.id === 'models')
  check('user: models lock registered', modelsReg !== undefined)
  if (modelsReg !== undefined) {
    check('user: models priority -1 (content winner)', modelsReg.opts.priority === -1, 'priority=' + modelsReg.opts.priority)
    check('user: models label', modelsReg.opts.label() === '模型')
    const texts = []
    const walk = (node) => {
      if (node === null || node === undefined) return
      if (typeof node === 'string') { texts.push(node); return }
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.props && node.props.children !== undefined) walk(node.props.children)
      if (Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(modelsReg.render().type())
    check('user: per-user panel renders', texts.some((t) => t.includes('查余额（全部配置）')), texts.join('|'))
    check('user: panel shows profiles as a table', texts.includes('名称') && texts.includes('余额'), texts.join('|'))
    check('user: panel states the no-config block (Q2)', texts.some((t) => t.includes('会被拒绝')), texts.join('|'))
  check('user: no account section is injected (the deployment has none either)', !s2.recorded.some((r) => r.opts.id === 'account'))
  }

  // ---- 只读会话：前端先拦（行为断言，不是字符串匹配）----
  {
    const rpcCalls = []
    const blockCalls = []
    const slotsRecorded = []
    const sessionsSnapshot = { ids: ['mine', 'theirs'], byId: { mine: { cwd: '/a' }, theirs: { cwd: '/b' } } }
    const conversation = { blocks: { set: (id, block) => { blockCalls.push([id, block]) } } }
    const guardSlots = {
      inject(key, cb) { cb() },
      register(opts, render) { slotsRecorded.push({ opts, render }) },
    }
    const guardCtx = {
      get: (n) => {
        if (n === 'slots') return guardSlots
        if (n === 'sessions') return { list: { getSnapshot: () => sessionsSnapshot, subscribe: () => () => {} } }
        if (n === 'conversation') return conversation
        return undefined
      },
      effect(cb) { cb() },
    }
    global.fetch = async (url, init) => {
      rpcCalls.push({ url, body: JSON.parse(init.body) })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          access: {
            mine: { writable: true, owner: 'alice', group: null },
            theirs: { writable: false, owner: 'bob', group: '项目 A2' },
          },
        }),
      }
    }
    exp.apply(guardCtx)
    await tick()
    check('只读守卫：用侧栏可见的会话 id 查询可写状态',
      rpcCalls.some((c) => c.url === '/auth/rpc/sessionAccess' && Array.isArray(c.body.ids)
        && c.body.ids.indexOf('theirs') !== -1 && c.body.ids.indexOf('mine') !== -1), JSON.stringify(rpcCalls))
    check('只读守卫：非归属会话的输入框被 block（占位符写明归属人与项目）',
      blockCalls.some(([id, block]) => id === 'theirs' && block !== undefined
        && String(block.reason).includes('bob') && String(block.reason).includes('只读')), JSON.stringify(blockCalls))
    check('只读守卫：自己的会话不 block（可自由输入）',
      !blockCalls.some(([id, block]) => id === 'mine' && block !== undefined), JSON.stringify(blockCalls))
    const badgeReg = slotsRecorded.find((r) => r.opts.name === 'conversation.session.header.utilities')
    const lockReg = slotsRecorded.find((r) => r.opts.name === 'sidebar.session.row.leading')
    check('只读守卫：会话头药丸与侧栏锁都注册了', badgeReg !== undefined && lockReg !== undefined,
      JSON.stringify(slotsRecorded.map((r) => r.opts.name)))
    const badgeMine = badgeReg.render({ sessionId: 'mine' })
    const badgeTheirs = badgeReg.render({ sessionId: 'theirs' })
    check('只读标记：自己的会话不显示药丸', badgeMine === null)
    check('只读标记：非归属会话显示「只读」药丸并带原因',
      badgeTheirs !== null && badgeTheirs.children.join('').includes('只读')
      && String(badgeTheirs.props.title).includes('bob'), JSON.stringify(badgeTheirs))
    const lockTheirs = lockReg.render({ sessionId: 'theirs' })
    check('只读标记：侧栏行显示小锁', lockTheirs !== null && String(lockTheirs.children).includes('🔒'))
  }

  // ---- 静态断言 ----
  check('nav-hide hack removed (0.2.0 settings-shell owns the nav)', !code.includes('dsh-ui-auth-groups-navhide') && !code.includes('nth-child(2)'))
  check('button color uses on-primary token', code.includes('--dsw-alias-label-primary-foreground'))
  check('button no longer uses contrast-fill', !code.includes('--dsw-alias-button-contrast-fill'))
  check('danger button uses on-primary token', /\.dshua button\.danger\{[^}]*--dsw-alias-label-primary-foreground/.test(code))
  check('inputs use box-sizing:border-box (width stays inside container, equal side margins)', /\.dshua input, \.dshua select\{[^}]*box-sizing:border-box/.test(code))
  {
    const inputRule = (code.match(/\.dshua input, \.dshua select\{[^}]*\}/) || [''])[0]
    check('input rule: width 100% + padding + border-box (never exceeds parent right edge)', inputRule.includes('width:100%') && inputRule.includes('padding:8px 10px') && inputRule.includes('box-sizing:border-box'))
  }
  check('TOTP card present (两步验证)', code.includes('两步验证（TOTP）') && code.includes('totpGenerate') && code.includes('totpVerify'))
  check('TOTP QR image rendering present', code.includes('TOTP 二维码') && code.includes('tQrUrl') && code.includes('src: tQrUrl'))
  check('TOTP login reminder present (showTotpReminder)', code.includes('showTotpReminder') && code.includes('建议开启两步验证') && code.includes('totpIgnore'))
  check('TOTP reminder once per session (sessionStorage gate + logout clear)', code.includes('dshua-totp-reminded') && code.includes('sessionStorage'))
  // 产物由 esbuild 生成，引号风格会被规范化（单引号→双引号），因此该断言不绑定引号风格。
check('2FA toggle is a switch (not checkbox)', /className: ['"]switch['"]/.test(code) && code.includes('dshua .switch input:checked + .track'))
  check('invite management card present (邀请码管理)', code.includes('邀请码管理（管理员）') && code.includes('inviteCreate') && code.includes('inviteList'))

  // ---- 通行密钥（Passkey，0.6.4）----
  check('Passkey card present (通行密钥)', code.includes('通行密钥（Passkey）') && code.includes('passkeyList') && code.includes('passkeyStepUp'))
  check('Passkey add flows: local device + phone QR', code.includes('本机通行密钥') && code.includes('手机扫码添加') && code.includes('localDevice') && code.includes('remoteDevice'))
  check('Passkey ceremonies use the community library (startRegistration/startAuthentication)',
    code.includes('startRegistration') && code.includes('startAuthentication') && code.includes('@simplewebauthn/browser'))
  check('Passkey step-up dialog present (改动登录因子前确认身份)', code.includes('确认身份') && code.includes('passkeyAddVerify') && code.includes('passkeyStepUp'))
  check('Passkey rename/remove wired', code.includes('passkeyRename') && code.includes('passkeyRemove') && code.includes('重命名') && code.includes('删除通行密钥'))
  check('Admin passkey recovery wired (清除通行密钥)', code.includes('passkeyReset') && code.includes('清除通行密钥'))
  check('Passkey origin hint surfaced (IP 字面量需改用 localhost)', code.includes('suggestedHost') && code.includes('无法使用通行密钥'))
  check('2FA switch label reflects the factor in use (动态码 / 通行密钥)', code.includes('登录需密码 + 动态码') && code.includes('登录需密码 + 通行密钥'))
  check('Passkey login reminder only when no factor exists', code.includes('passkeyCount') && code.includes('totpEnabled !== true'))

  // ---- 只读会话：前端标记 + 输入拦截（0.8.0）----
  check('只读守卫接线：会话头药丸 + 侧栏锁 + 输入框 block',
    code.includes('conversation.session.header.utilities') && code.includes('sidebar.session.row.leading')
    && code.includes('installReadOnlyGuards'))
  check('只读守卫走 DSH 官方 block 接缝（并在卸载时清理）',
    code.includes('.blocks') && code.includes('accessBlocked'))
  check('只读状态来自 /auth/rpc/sessionAccess（带 TTL 与在途去重）',
    code.includes("sessionAccess") && code.includes('ACCESS_TTL_MS') && code.includes('accessInflight'))
  check('只读提示文案（中英）不写死单语', code.includes('只读会话') && code.includes('Read-only session'))

  console.log(failures === 0 ? '\nCLIENT BUNDLE SMOKE TEST PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
})()
