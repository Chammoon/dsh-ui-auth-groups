import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { createModernPolicy, remoteArgs, object, nonempty } from './modern-policy.js'
import type { ModelEntitlement } from './modern-policy.js'
import type { JsonObject, ModernPolicy, Principal, StreamCorrelation } from './modern-policy.js'

/**
 * DSH 0.1.2+ transport adapter: slash Remote (`/api/<ns>/<method>`), the
 * `/api/remote.mux` stream mux, and the native browser carrier.
 *
 * Adapted from the DSH 0.1.2 draft (#1) to the reviewed 0.1.5-rc.1 surface and
 * re-verified against 0.2.0-rc.2; the legacy dotted/`apiProxy` path was removed in
 * v0.7.0, so this adapter is the only transport. Design rules kept from that draft:
 * - a plugin-authenticated request is bridged to the native carrier internally,
 *   so the browser never holds the process launch token or the native cookie;
 * - unknown endpoints and unknown events fail closed for ordinary users;
 * - ownership is re-checked on every stream delivery and on logout/role change;
 * - a hidden waterfall recipient is released with `next` so an owner's
 *   interaction cannot be stranded.
 */
const MAX_BODY = 16 * 1024 * 1024
const MAX_STREAMS = 64
const MUX_PATH = '/api/remote.mux'
/** Exact `/api` Fetch routes that bypass Remote dispatch (0.1.5 inventory). */
const HOST_CAPABILITY_PATHS = new Set(['/api/file', '/api/present.host', '/api/present.open'])
/** Own-session browser routes whose ownership is the `sessionId` query parameter. */
/** Read-side routes that address a session by query parameter (group-aware read predicate). */
const SESSION_EXPORT_PATHS = new Set(['/api/session.export'])
/** Write-side route (stages bytes under a session): owner only, exactly like `fileUploads/upload`. */
const SESSION_UPLOAD_PATHS = new Set(['/api/session/uploadFileBinary'])
/** Host-side app opening; never an ordinary-user capability. */
const HOST_OPEN_PREFIX = '/open-in-app/'

/** Native connection service seam (`ctx.get('connection')`, DSH 0.1.2+). */
interface NativeConnection {
  authenticatedUrl(baseUrl: string): string
  authorizeIndex(
    request: { method: string; url: string; headers: { host: string } },
    response: { writeHead(status: number, headers?: Record<string, string | undefined>): void; end(): void },
  ): boolean
  requestRejection(request: IncomingMessage): number | undefined
  createSharedFetchHandler(prefix: string): { fetch(request: Request): Promise<Response> }
}

/** Typert gateway seam (`ctx.get('typertGateway')`). */
interface TypertGateway {
  wireStream?: {
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  }
}

/** The plugin-side facts the gateway needs (implemented in `index.ts`). */
export interface ModernAuth {
  ready: Promise<unknown>
  user(username: string): Principal | undefined
  principal(req: IncomingMessage): Principal | undefined
  loginKey(req: IncomingMessage): string
  session(id: string): string
  workspace(id: string): string
  /** 会话冻结的组绑定（无 = 私有会话）。 */
  sessionGroup(id: string): string | undefined
  /** 会话创建时所在的工作区（fork 继承用）。 */
  sessionWorkspace(id: string): string | undefined
  /** 工作区绑定的组（无 = 私有工作区）。 */
  workspaceGroup(id: string): string | undefined
  /**
   * 成员关系：`username` 是否属于 `groupId`。
   * 可见性判定是「查看者 ∈ 对象所属组」，因此这里只回答成员关系。
   */
  isMember(username: string, groupId: string): boolean
  sessionExists(id: string): Promise<boolean>
  claimSession(id: string, username: string): Promise<void>
  claimWorkspace(id: string, username: string): Promise<void>
  bindSession(id: string, workspaceId: string | undefined, groupId: string | undefined): Promise<void>
  /**
   * 普通用户的工作区文件读取必须落在该会话的工作区内（宿主 `workspaceFiles/*` 不限制路径）。
   * 未接线时保持上游行为。
   */
  confinePaths?(principal: Principal, sessionId: string, path: string, baseFile: string | undefined): Promise<boolean> | boolean
  /**
   * R2：按登录用户返回模型授权范围（provider + 逐模型）。返回 undefined 表示不裁剪；
   * 管理员在策略层直接绕过，不会走到这里。
   */
  entitlement?(principal: Principal): Promise<ModelEntitlement | undefined> | ModelEntitlement | undefined
}

/** The seam downstream plugins consume through `ctx.get('uiAuth')`. */
export interface UiAuthPublicApi {
  ready: Promise<unknown>
  user(username: string): Principal | undefined
  principal(req: IncomingMessage): Principal | undefined
  ownerOfSession(id: string): string
  ownerOfWorkspace(id: string): string
  claimSession(id: string, username: string): Promise<void>
  claimWorkspace(id: string, username: string): Promise<void>
  registerPolicy(id: string, rules: PolicyRules): () => void
}

/** A downstream-registered policy extension (see docs/DSH-0.1.5-COMPATIBILITY.md). */
export interface PolicyRules {
  http?: {
    matches(target: { pathname: string; method?: string }): boolean
    authorize(principal: Principal, request: IncomingMessage): boolean | Promise<boolean>
  }
  rpc?: {
    matches(endpoint: string): boolean
    authorize(principal: Principal, payload: unknown): boolean | Promise<boolean>
    project(principal: Principal, value: unknown): unknown | Promise<unknown>
  }
  remote?: {
    matches(endpoint: string): boolean
    authorize(principal: Principal, payload: unknown): boolean | Promise<boolean>
  }
  stream?: {
    matches(endpoint: string): boolean
    authorize(principal: Principal, payload: unknown): boolean | Promise<boolean>
    project(principal: Principal, value: unknown): unknown | Promise<unknown>
  }
  upgrade?: {
    matches(target: { pathname: string }): boolean
    authorize(principal: Principal, request: IncomingMessage): boolean | Promise<boolean>
  }
}

/** The minimal Cordis context surface this module touches. */
export interface ModernGatewayContext {
  get(service: string): unknown
  provide?(service: string, value: unknown): void
  effect(callback: () => () => void, label?: string): unknown
}

/** One logical mux stream owned by a connection generation. */
interface StreamWork {
  abort: AbortController
  correlation: StreamCorrelation
}

export interface ModernGateway {
  handleHttp(req: IncomingMessage, res: ServerResponse, forward: (req: IncomingMessage, res: ServerResponse) => void): Promise<boolean>
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    forward: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void
  publicApi: UiAuthPublicApi
}

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const denial = (): Error => new Error('Access denied')

async function bodyOf(req: IncomingMessage): Promise<{ body: Buffer; envelope: JsonObject }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY) throw new Error('Request too large')
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks)
  return { body, envelope: JSON.parse(body.toString('utf8')) as JsonObject }
}

/** Replay once, preserving IncomingMessage events used by downstream HTTP bridges. */
function replay(req: IncomingMessage, body: Buffer): IncomingMessage {
  const proxy: IncomingMessage = Object.create(req) as IncomingMessage
  ;(proxy as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<Buffer> })[Symbol.asyncIterator] =
    async function* () { if (body.length) yield body }
  return proxy
}

/** Delay success until ownership has persisted; never forward an unfiltered prefix. */
async function forwardJson(
  forward: (req: IncomingMessage, res: ServerResponse) => void,
  req: IncomingMessage,
  res: ServerResponse,
  transform: (value: unknown) => Promise<unknown>,
): Promise<void> {
  const original = { writeHead: res.writeHead, write: res.write, end: res.end }
  let status = 200
  let size = 0
  const chunks: Buffer[] = []
  const headers: Record<string, unknown> = {}
  await new Promise<void>((resolve, reject) => {
    const restore = (): void => { Object.assign(res, original) }
    const capture = (chunk: unknown): void => {
      if (chunk === null || chunk === undefined) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += buffer.length
      if (size > MAX_BODY) throw new Error('Response too large')
      chunks.push(buffer)
    }
    res.writeHead = ((code: number, reason?: unknown, fields?: unknown) => {
      status = code
      Object.assign(headers, typeof reason === 'object' && reason !== null ? reason : fields)
      return res
    }) as typeof res.writeHead
    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      try { capture(chunk) } catch (error) { restore(); reject(error); return false }
      if (typeof encoding === 'function') (encoding as () => void)()
      else (callback as (() => void) | undefined)?.()
      return true
    }) as typeof res.write
    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      void (async () => {
        try {
          capture(chunk)
          let body = Buffer.concat(chunks)
          if (status >= 200 && status < 300) {
            const envelope = JSON.parse(body.toString('utf8')) as { result?: { ok?: boolean; value?: unknown } }
            if (envelope?.result?.ok === true) envelope.result.value = await transform(envelope.result.value)
            body = Buffer.from(JSON.stringify(envelope))
          }
          restore()
          // The body is re-serialized here: framing/encoding headers of the original
          // bytes no longer describe it, so they must not survive the projection.
          for (const header of ['content-length', 'Content-Length', 'content-encoding', 'Content-Encoding', 'transfer-encoding', 'Transfer-Encoding']) {
            delete headers[header]
            res.removeHeader?.(header)
          }
          res.writeHead(status, headers as Record<string, string>)
          res.end(body)
          if (typeof encoding === 'function') (encoding as () => void)()
          else (callback as (() => void) | undefined)?.()
          resolve()
        } catch (error) { restore(); reject(error) }
      })()
      return res
    }) as typeof res.end
    try { forward(req, res) } catch (error) { restore(); reject(error) }
    res.once('close', () => { restore(); resolve() })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createModernGateway(ctx: ModernGatewayContext, auth: ModernAuth): ModernGateway {
  const policy: ModernPolicy = createModernPolicy(auth, {
    ...(auth.entitlement === undefined ? {} : { entitlement: auth.entitlement }),
    ...(auth.confinePaths === undefined ? {} : { confinePaths: auth.confinePaths }),
  })
  const policies = new Map<string, PolicyRules>()
  const principalByRequest = new WeakMap<IncomingMessage, Principal>()
  const correlations = new Set<StreamCorrelation>()
  const downstreamSockets = new Set<Duplex>()
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })
  const principal = (req: IncomingMessage): Principal | undefined => auth.principal(req)
  const publicApi: UiAuthPublicApi = Object.freeze({
    ready: auth.ready,
    user: auth.user,
    principal: (req: IncomingMessage) => principalByRequest.get(req),
    ownerOfSession: auth.session,
    ownerOfWorkspace: auth.workspace,
    // Trusted Host provisioners own these calls; they are not browser RPCs.
    async claimSession(id: string, username: string) { await auth.ready; return auth.claimSession(id, username) },
    async claimWorkspace(id: string, username: string) { await auth.ready; return auth.claimWorkspace(id, username) },
    registerPolicy(id: string, rules: PolicyRules) {
      if (!nonempty(id) || policies.has(id)) throw new Error('Duplicate or invalid auth policy')
      policies.set(id, rules)
      return () => { policies.delete(id) }
    },
  })
  ctx.provide?.('uiAuth', publicApi)

  function extension<K extends keyof PolicyRules>(kind: K, target: unknown): PolicyRules[K] | undefined {
    const matches = [...policies.values()].filter(rule => {
      const section = rule[kind] as { matches?(value: unknown): boolean } | undefined
      return section?.matches?.(target) === true
    })
    if (matches.length > 1) throw new Error('Ambiguous authorization policy')
    return matches[0]?.[kind]
  }

  /**
   * `session/create` 自带一个**别人的**会话 id 时，宿主本会回 `session/writer-held`，
   * DSH 客户端据此自动改用新会话重试（`reuseBlank` 的降级路径，见 ui-workspace/navigation）。
   *
   * 策略层先拦下请求之后，必须用同一个错误码回应，否则成员在组工作区里点开别人留下的
   * 空白会话时界面会直接报错，而不是替他开一个新会话。
   *
   * 只对「调用者本来就能读」的会话这么做：不可见的会话保持纯 403，避免把它变成存在性预言机。
   */
  async function writerHeldRefusal(who: Principal, endpoint: string, payload: unknown): Promise<JsonObject | undefined> {
    if (endpoint !== 'session/create') return undefined
    const args = remoteArgs(payload)
    const request = args !== undefined && object(args.request) ? args.request : args
    const sessionId = object(request) ? request.sessionId : undefined
    if (!nonempty(sessionId) || auth.session(sessionId) === who.username) return undefined
    if (!policy.session(who, sessionId)) return undefined
    const exists = await auth.sessionExists(sessionId).catch(() => true)
    if (!exists) return undefined
    return {
      type: 'server-response',
      result: {
        ok: false,
        error: {
          code: 'session/writer-held',
          message: `session "${sessionId}" belongs to another user`,
          details: { sessionId },
        },
      },
    }
  }

  /**
   * The single `sessionId` of a query-addressed route.
   *
   * 宿主用 `Object.fromEntries(url.searchParams)` 取值 —— **重复参数取最后一个**，
   * 而 `get()` 取第一个。两者分叉会让「检查 A 的会话、导出 B 的会话」成为可能，
   * 所以重复参数一律视为非法（fail-closed）。
   */
  function querySessionId(url: URL): string | undefined {
    const values = url.searchParams.getAll('sessionId')
    return values.length === 1 && nonempty(values[0]) ? values[0] : undefined
  }
  /** Own a `sessionId` query parameter on the read-side `/api` routes that bypass Remote dispatch. */
  function ownsQuerySession(who: Principal, url: URL): boolean {
    // 与 Remote 面同一套读谓词：管理员、归属人本人，以及组会话的组内成员。
    const sessionId = querySessionId(url)
    return sessionId !== undefined && policy.session(who, sessionId)
  }
  /**
   * Write-side query session (binary upload stages bytes under the addressed session).
   * 与 Remote 面的 `fileUploads/upload` 同一谓词：**仅归属人本人**（组内可读不等于可写）。
   */
  function ownsQuerySessionWrite(who: Principal, url: URL): boolean {
    const sessionId = querySessionId(url)
    return sessionId !== undefined && auth.session(sessionId) === who.username
  }

  function prepare(req: IncomingMessage): { status: number } | { who: Principal; carrier?: string; status?: undefined } {
    const who = principal(req)
    if (who === undefined) return { status: 401 }
    const connection = ctx.get('connection') as NativeConnection | undefined
    if (connection === undefined) return { status: 503 }
    const host = req.headers.host
    if (typeof host !== 'string') return { status: 403 }
    // Mint this process's carrier cookie. It is injected into every request we forward, and it is
    // ALSO mirrored back to the browser (see handleHttp): the app's own connection module needs to
    // hold a carrier of its own to finish its handshake, and without it the client loops on
    // "connection lost". Mirroring is safe because the outer gate still demands a live
    // dsh-ui-auth-groups session before anything is forwarded.
    let cookie: string | undefined
    let carrier: string | undefined
    try {
      const url = new URL(connection.authenticatedUrl(`http://${host}`))
      connection.authorizeIndex({ method: 'GET', url: url.pathname + url.search, headers: { host } }, {
        writeHead(_status, headers) {
          const raw = headers?.['set-cookie']
          if (raw === undefined) return
          cookie = raw.split(';')[0]
          carrier = raw
        },
        end() {},
      })
    } catch { return { status: 403 } }
    if (cookie === undefined) return { status: 503 }
    // Ignore client-supplied native carrier cookies; use only this process's freshly issued one.
    const retained = (req.headers.cookie ?? '').split(';').filter(part => !part.trim().startsWith('dsh-auth-')).join(';')
    req.headers.cookie = `${retained}; ${cookie}`
    const rejected = connection.requestRejection(req)
    if (rejected !== undefined) return { status: rejected }
    principalByRequest.set(req, who)
    return { who, ...(carrier === undefined ? {} : { carrier }) }
  }

  async function handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    forward: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<boolean> {
    const admitted = prepare(req)
    if (admitted.status !== undefined) { json(res, admitted.status, { error: 'Access denied' }); return true }
    const who = admitted.who
    // 把现铸的载体 Cookie 回写给浏览器：客户端的连接模块需要自己持有一个载体才能完成握手，
    // 否则会一直 "connection lost" 重连（实测：闸门透传时该症状消失）。外层仍由本插件的会话
    // Cookie 把关——gate 对每个请求都会核对会话，所以浏览器持有该 Cookie 不构成绕过。
    if (admitted.carrier !== undefined && !res.headersSent) {
      try { res.setHeader('set-cookie', admitted.carrier) } catch (error) { /* 头已发出则忽略 */ }
    }
    const url = new URL(req.url as string, 'http://local')
    const pathname = url.pathname
    const rule = extension('http', { pathname, method: req.method })
    if (rule !== undefined) {
      if (!(await rule.authorize(who, req))) json(res, 403, { error: 'Access denied' })
      else forward(req, res)
      return true
    }
    // Host-side app opening registers outside /api and would otherwise pass on the carrier cookie alone.
    if (pathname.startsWith(HOST_OPEN_PREFIX)) {
      if (who.role !== 'admin') { json(res, 403, { error: 'Access denied' }); return true }
      return false
    }
    if (!pathname.startsWith('/api/')) return false
    // Exact Fetch routes registered beside the RPC channel: never a Remote endpoint.
    if (HOST_CAPABILITY_PATHS.has(pathname)) {
      if (who.role !== 'admin') { json(res, 403, { error: 'Access denied' }); return true }
      return false
    }
    if (SESSION_EXPORT_PATHS.has(pathname) || SESSION_UPLOAD_PATHS.has(pathname)) {
      const granted = SESSION_UPLOAD_PATHS.has(pathname) ? ownsQuerySessionWrite(who, url) : ownsQuerySession(who, url)
      if (!granted) { json(res, 403, { error: 'Access denied' }); return true }
      return false
    }
    if (pathname === MUX_PATH) {
      if (who.role !== 'admin') { json(res, 403, { error: 'Access denied' }); return true }
      return false
    }
    if (req.method !== 'POST') {
      // Host exports and third-party GETs need an explicit policy for ordinary users.
      if (who.role !== 'admin') { json(res, 403, { error: 'Access denied' }); return true }
      return false
    }
    const endpoint = pathname.slice('/api/'.length)
    let decoded: { body: Buffer; envelope: JsonObject }
    try { decoded = await bodyOf(req) }
    catch { json(res, 400, { error: 'Invalid request' }); return true }
    const { envelope, body } = decoded
    if (envelope?.type !== 'client-request' || envelope.method !== endpoint || !nonempty(envelope.rpcId)) {
      json(res, 400, { error: 'Invalid request' }); return true
    }
    let allowed: boolean
    for (const rules of policies.values()) {
      const remote = rules.remote
      if (remote?.matches(endpoint) === true && !(await remote.authorize(who, envelope.payload))) {
        const refusal = await writerHeldRefusal(who, endpoint, envelope.payload)
        if (refusal !== undefined) { json(res, 200, { ...refusal, rpcId: envelope.rpcId }); return true }
        json(res, 403, { error: 'Access denied' }); return true
      }
    }
    if (endpoint === '$events/result') {
      const args = remoteArgs(envelope.payload)
      // Bind approval/event responses to this login token, connection generation and delivered event.
      allowed = object(args) && [...correlations].some(correlation =>
        correlation.login === auth.loginKey(req) && correlation.clientId === (args as JsonObject).clientId
        && correlation.events.has((args as JsonObject).eventId as string))
    } else {
      const rule = extension('rpc', endpoint)
      allowed = rule ? await rule.authorize(who, envelope.payload) : await policy.authorize(who, endpoint, envelope.payload)
    }
    if (!allowed) {
      const refusal = await writerHeldRefusal(who, endpoint, envelope.payload)
      if (refusal !== undefined) { json(res, 200, { ...refusal, rpcId: envelope.rpcId }); return true }
      json(res, 403, { error: 'Access denied' }); return true
    }
    // The response is parsed and re-serialized for ownership projection, so the upstream
    // half must hand back identity bytes: a compressed body cannot be projected.
    req.headers['accept-encoding'] = 'identity'
    const request = replay(req, body)
    principalByRequest.set(request, who)
    try {
      await forwardJson(forward, request, res, async value => {
        const rule = endpoint === '$events/result' ? undefined : extension('rpc', endpoint)
        const projected = rule
          ? await rule.project(who, value)
          : await policy.result(who, endpoint, value, envelope.payload)
        const current = principal(req)
        if (current?.role !== who.role || current.username !== who.username) throw denial()
        return projected
      })
    } catch (error) {
      // Never inherit framing/encoding headers captured from the attempt that failed.
      for (const header of ['content-length', 'Content-Length', 'content-encoding', 'Content-Encoding', 'transfer-encoding', 'Transfer-Encoding']) {
        delete (res.getHeaders?.() as Record<string, unknown>)[header]
        res.removeHeader?.(header)
      }
      console.error('[dsh-ui-auth-groups] modern gateway projection failed: ' + errorMessage(error))
      if (!res.headersSent) json(res, 502, { error: 'Could not persist or project response' })
      else res.destroy()
    }
    return true
  }

  function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    forward: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void {
    const admitted = prepare(req)
    const reject = (status: number): void => { socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
    if (admitted.status !== undefined) { reject(admitted.status); return }
    const who = admitted.who
    const pathname = new URL(req.url as string, 'http://local').pathname
    if (pathname !== MUX_PATH) {
      const rule = extension('upgrade', { pathname })
      const pass = (): void => {
        downstreamSockets.add(socket)
        const timer = setInterval(() => {
          const current = principal(req)
          if (current?.username !== who.username || current.role !== who.role) socket.destroy()
        }, 1000)
        timer.unref()
        socket.once('close', () => { clearInterval(timer); downstreamSockets.delete(socket) })
        forward(req, socket, head)
      }
      if (rule === undefined) { if (who.role === 'admin') pass(); else reject(403); return }
      Promise.resolve(rule.authorize(who, req)).then(granted => {
        if (granted && principal(req) !== undefined) pass()
        else reject(403)
      }, () => reject(403))
      return
    }
    const gateway = ctx.get('typertGateway') as TypertGateway | undefined
    const wireStream = gateway?.wireStream
    if (wireStream?.open === undefined) { reject(503); return }
    sockets.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const active = new Map<string, StreamWork>()
      const login = auth.loginKey(req)
      const initialRole = who.role
      let writes: Promise<void> = Promise.resolve()
      const alive = (): Principal | undefined => {
        const current = principal(req)
        return current?.username === who.username && current.role === initialRole && auth.loginKey(req) === login ? current : undefined
      }
      const send = (value: unknown): Promise<void> => {
        writes = writes.then(() => new Promise<void>((resolve, rejectSend) => {
          if (alive() === undefined || ws.readyState !== WebSocket.OPEN) { rejectSend(denial()); return }
          const serialized = JSON.stringify(value)
          if (Buffer.byteLength(serialized) > MAX_BODY || ws.bufferedAmount > MAX_BODY) { ws.close(1009, 'Stream limit exceeded'); rejectSend(denial()); return }
          ws.send(serialized, error => error ? rejectSend(error) : resolve())
        }))
        return writes
      }
      const timer = setInterval(() => { if (alive() === undefined) ws.close(1008, 'Login expired') }, 1000)
      timer.unref()
      ws.on('error', () => ws.terminate())
      ws.on('close', () => {
        clearInterval(timer)
        for (const work of active.values()) { work.abort.abort(); correlations.delete(work.correlation) }
      })
      ws.on('message', (bytes: Buffer, binary: boolean) => {
        let message: JsonObject | undefined
        try { message = JSON.parse(bytes.toString()) as JsonObject } catch { ws.close(1008, 'Invalid stream request'); return }
        if (binary || alive() === undefined || !nonempty(message?.streamId)) { ws.close(1008, 'Invalid stream request'); return }
        if (message.type === 'cancel' && Object.keys(message).length === 2) {
          active.get(message.streamId as string)?.abort.abort(); return
        }
        if (message.type !== 'open' || Object.keys(message).length !== 4 || typeof message.endpoint !== 'string'
          || active.has(message.streamId as string) || active.size >= MAX_STREAMS) { ws.close(1008, 'Invalid stream request'); return }
        const streamId = message.streamId as string
        const endpoint = message.endpoint
        const payload = message.payload
        const work: StreamWork = { abort: new AbortController(), correlation: { login, events: new Set<string>() } }
        active.set(streamId, work)
        correlations.add(work.correlation)
        void (async () => {
          try {
            const current = alive()
            const rule = extension('stream', endpoint)
            if (current === undefined || !(rule ? await rule.authorize(current, payload) : await policy.authorize(current, endpoint, payload, true))) throw denial()
            const source = await wireStream.open(endpoint, payload, work.abort.signal)
            for await (const value of source) {
              if (work.abort.signal.aborted) break
              const watcher = alive()
              if (watcher === undefined) throw denial()
              if (rule !== undefined && extension('stream', endpoint) !== rule) throw denial()
              // Recheck ownership as well as login state throughout a scoped stream.
              if (!(rule ? await rule.authorize(watcher, payload) : await policy.authorize(watcher, endpoint, payload, true))) throw denial()
              const output = rule ? await rule.project(watcher, value) : policy.frame(watcher, endpoint, value, work.correlation)
              const frame = object(value) ? value : undefined
              if (endpoint === '$events' && frame?.type === 'waterfall' && output === null) {
                // A hidden recipient must release its delivery, otherwise an owner's "next"
                // waits forever on users who were correctly not shown the interaction.
                const endpoint = '$events/result'
                const connection = ctx.get('connection') as NativeConnection
                const response = await connection.createSharedFetchHandler('/api').fetch(new Request(`http://dsh.internal/api/${endpoint}`, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ type: 'client-request', rpcId: frame.eventId, method: endpoint, payload: { args: {
                    clientId: work.correlation.clientId, eventId: frame.eventId, outcome: { kind: 'next' },
                  } } }),
                }))
                const settled = await response.json() as { result?: { ok?: boolean } }
                if (!settled.result?.ok) throw denial()
              }
              if (output !== null) await send({ type: 'item', streamId, value: output })
            }
            if (!work.abort.signal.aborted) await send({ type: 'end', streamId })
          } catch {
            if (!work.abort.signal.aborted) {
              await send({ type: 'error', streamId, error: { code: 'auth/forbidden', message: 'Stream unavailable or access denied', details: {} } })
                .catch(() => ws.close(1008))
            }
          } finally { correlations.delete(work.correlation); active.delete(streamId) }
        })()
      })
    })
  }

  ctx.effect(() => () => {
    for (const socket of sockets.clients) socket.terminate()
    for (const socket of downstreamSockets) socket.destroy()
    sockets.close()
    policies.clear()
    correlations.clear()
  }, 'dsh-ui-auth-groups: modern gateway')
  return { handleHttp, handleUpgrade, publicApi }
}
