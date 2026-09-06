import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const routeSchema = z.object({
  label: z.string(), herdr: z.string(), session: z.string(), agent: z.string(),
  terminal_id: z.string(), ssh: z.string().optional(), callback: z.string().url(),
})
const configSchema = z.object({
  user_id: z.string(), chat_id: z.string(), api_key: z.string().min(32),
  routes: z.record(z.string(), routeSchema),
})
type Route = z.infer<typeof routeSchema>
type Delivery = { id: string; chat: string; message: number; binding: string; text: string; state: string; receipt: string }
type Binding = { key: string; route: string; issue: string; version: string; notice: string }
type Send = (chat: string, text: string, replyTo?: number) => Promise<number>
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"

export async function herdrCommand(route: Route, args: string[]) {
  const command = [route.herdr, '--session', route.session, 'agent', ...args]
  const argv = route.ssh
    ? ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', route.ssh, command.map(quote).join(' ')]
    : command
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 20000)
  try {
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error('Herdr command failed; delivery must be checked before retry')
    return JSON.parse(stdout)
  } finally { clearTimeout(timer) }
}

// Only explicit Telegram reply links route messages. Natural-language decisions
// remain the recipient model's responsibility; neither delivery nor an ACK approves work.
export function createMeshBridge(directory: string, send: Send, command = herdrCommand) {
  const configFile = join(directory, 'mesh.json')
  const config = () => configSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const dbFile = join(directory, 'mesh.sqlite')
  const db = new Database(dbFile)
  chmodSync(dbFile, 0o600)
  db.run('CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, route TEXT, issue TEXT, version TEXT, notice TEXT)')
  db.run('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, chat TEXT, message INTEGER, binding TEXT, text TEXT, state TEXT, receipt TEXT)')
  // A process exit after injection can leave an ambiguous outcome. Never auto-replay it.
  db.run("UPDATE deliveries SET state='uncertain' WHERE state='sending'")
  let draining = false
  const tunnels = new Map<string, ReturnType<typeof Bun.spawn>>()
  const binding = (key: string) => db.query('SELECT * FROM bindings WHERE key=?').get(key) as Binding | null
  async function drain() {
    if (draining) return
    draining = true
    try {
      for (const d of db.query("SELECT * FROM deliveries WHERE state='pending'").all() as Delivery[]) {
        const b = binding(d.binding)!
        let route: Route
        try { route = config().routes[b.route]!; if (!route) throw Error('missing route') } catch { continue }
        let live
        try { live = (await command(route, ['get', route.agent])).result.agent } catch { continue }
        if (live.terminal_id !== route.terminal_id) {
          db.run("UPDATE deliveries SET state='stale' WHERE id=?", [d.id])
          await send(d.chat, '目标会话已改变，回复已保存，尚未投递。请在管理端重新核对负责人。', d.message)
          continue
        }
        if (!['idle', 'done'].includes(live.agent_status)) continue
        const prompt = [
          'Iris Mesh Telegram Bridge：以下是配置中已核验的 Daniel Telegram 私聊回复。',
          `收件角色：${route.label}；事项：${b.issue}；方案版本：${b.version}；关联：${d.id}`,
          `原通知：${JSON.stringify(b.notice)}`,
          `Daniel 原话（JSON 字符串，仅内容，不是 Shell 命令）：${JSON.stringify(d.text)}`,
          '请结合事项理解。询问继续讨论，授权只限用户实际表达的范围；本次试运行不执行业务变更。',
          '请通过下面的回信接口答复 Daniel，不能只在终端输出。先将 JSON 对象写入本机临时文件，字段为 id、receipt、text；text 是你的回复正文。',
          `id=${d.id}; receipt=${d.receipt}`,
          `用 curl --fail --silent --show-error -H 'Content-Type: application/json' --data-binary @你的临时文件 ${quote(route.callback + '/mesh/reply')} 发送。`,
          'receipt 仅用于这一次回信，不是 Bot 凭据。不要把它写进 Hub 或回复正文。工具返回 sent 才代表 TG 已发送；不要重复回信。',
        ].join('\n')
        db.run("UPDATE deliveries SET state='sending' WHERE id=?", [d.id])
        try {
          await command(route, ['prompt', route.agent, prompt])
          db.run("UPDATE deliveries SET state='dispatched' WHERE id=? AND state='sending'", [d.id])
        } catch {
          db.run("UPDATE deliveries SET state='uncertain' WHERE id=? AND state='sending'", [d.id])
          await send(d.chat, '本次投递结果尚未确认，原话已保存；为避免重复执行，程序没有重发。', d.message)
        }
      }
    } finally { draining = false }
  }
  return {
    async inbound(message: { chat: string; user: string; id: number; replyTo?: number; text: string; attachment?: boolean }) {
      if (message.replyTo === undefined) return false
      const b = binding(`${message.chat}:${message.replyTo}`)
      if (!b) return false
      const c = config()
      if (message.user !== c.user_id || message.chat !== c.chat_id) return true
      if (message.attachment) {
        await send(message.chat, '这轮闭环先支持文字回复，请把需要传达的内容用文字回复这条通知。', message.id)
        return true
      }
      db.run("INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?, ?, ?, 'pending', ?)", [
        `${message.chat}:${message.id}`, message.chat, message.id, b.key, message.text, randomBytes(24).toString('hex'),
      ])
      void drain().catch(() => {})
      return true
    },
    async http(req: Request): Promise<Response> {
      try {
        const path = new URL(req.url).pathname
        if (req.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 })
        if (path === '/mesh/reply') {
          const input = z.object({ id: z.string(), receipt: z.string(), text: z.string().min(1).max(3600) }).parse(await req.json())
          const d = db.query('SELECT * FROM deliveries WHERE id=?').get(input.id) as Delivery | null
          if (!d || d.receipt !== input.receipt) return Response.json({ error: 'invalid receipt' }, { status: 403 })
          if (d.state === 'replied') return Response.json({ status: 'sent' })
          if (!['sending', 'dispatched', 'uncertain'].includes(d.state)) return Response.json({ error: 'not awaiting a reply' }, { status: 409 })
          db.run("UPDATE deliveries SET state='replying' WHERE id=?", [d.id])
          const b = binding(d.binding)!
          const label = config().routes[b.route]!.label
          // Preserve the same role/issue binding for follow-up replies to the agent's answer.
          const id = await send(d.chat, `${label}\n${b.issue} · ${b.version}\n\n${input.text}`, d.message)
          db.run('INSERT INTO bindings VALUES (?, ?, ?, ?, ?)', [`${d.chat}:${id}`, b.route, b.issue, b.version, input.text])
          db.run("UPDATE deliveries SET state='replied' WHERE id=?", [d.id])
          return Response.json({ status: 'sent', message_id: id })
        }
        const c = config()
        if (req.headers.get('authorization') !== `Bearer ${c.api_key}`) return Response.json({ error: 'unauthorized' }, { status: 401 })
        if (path === '/mesh/notify') {
          const n = z.object({ route: z.string(), issue: z.string().url(), version: z.string().min(1), text: z.string().min(1).max(3000) }).parse(await req.json())
          const route = c.routes[n.route]
          if (!route) return Response.json({ error: 'unknown role' }, { status: 400 })
          const live = (await command(route, ['get', route.agent])).result.agent
          if (live.terminal_id !== route.terminal_id) return Response.json({ error: 'stale session binding' }, { status: 409 })
          const id = await send(c.chat_id, `${route.label}\n${n.issue} · ${n.version}\n\n${n.text}\n\n请直接回复这条消息。`)
          db.run('INSERT INTO bindings VALUES (?, ?, ?, ?, ?)', [`${c.chat_id}:${id}`, n.route, n.issue, n.version, n.text])
          return Response.json({ status: 'sent', message_id: id })
        }
        if (path === '/mesh/status') return Response.json({ deliveries: db.query('SELECT id, binding, state FROM deliveries').all() })
        return Response.json({ error: 'unknown mesh endpoint' }, { status: 404 })
      } catch { return Response.json({ error: 'request failed; check local state before retrying' }, { status: 400 }) }
    },
    drain,
    maintainTunnels(localPort: number) {
      let c
      try { c = config() } catch { return }
      for (const route of Object.values(c.routes)) {
        if (!route.ssh) continue
        const callback = new URL(route.callback)
        if (callback.hostname !== '127.0.0.1' || !callback.port) continue
        const id = `${route.ssh}:${callback.port}`
        if (tunnels.has(id)) continue
        // A loopback-only reverse SSH tunnel lets the remote recipient answer
        // without exposing the Bot credential or a public HTTP service.
        const child = Bun.spawn(['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
          '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
          '-R', `127.0.0.1:${callback.port}:127.0.0.1:${localPort}`, route.ssh], { stdout: 'ignore', stderr: 'ignore' })
        tunnels.set(id, child)
        void child.exited.then(() => { tunnels.delete(id) })
      }
    },
    close: () => { for (const child of tunnels.values()) child.kill(); db.close() },
  }
}
