import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMeshBridge } from './mesh-bridge'

test('notification → bound human reply → correct Herdr recipient → TG answer → follow-up, without duplicate dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-test-'))
  const key = 'x'.repeat(32)
  const route = { label: 'Architect', herdr: '/herdr', session: 'default', agent: 'architect', terminal_id: 'term1', callback: 'http://localhost:3500' }
  writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ user_id: '42', chat_id: '42', api_key: key, routes: { architect: route } }))
  const sent: { text: string; reply?: number }[] = []
  const prompts: string[] = []
  let busy = true
  let bridge = createMeshBridge(dir, async (_chat, text, reply) => { sent.push({ text, reply }); return sent.length }, async (_route, args) => {
    if (args[0] === 'get') return { result: { agent: { terminal_id: 'term1', agent_status: busy ? 'working' : 'idle' } } }
    expect(args.slice(0, 2)).toEqual(['prompt', 'architect'])
    prompts.push(args[2]!)
    return { result: {} }
  })
  const request = (path: string, body: unknown, auth = true) => new Request('http://localhost' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })
  try {
    const notice = { route: 'architect', issue: 'https://github.com/owner/hub/issues/1', version: 'v2', text: '方案 A 待确认' }
    expect((await bridge.http(request('/mesh/notify', notice, false))).status).toBe(401)
    expect((await bridge.http(request('/mesh/notify', notice))).status).toBe(200)
    expect(await bridge.inbound({ chat: '42', user: '42', id: 5, text: 'unbound' })).toBe(false)
    await bridge.inbound({ chat: '42', user: '99', id: 6, replyTo: 1, text: 'wrong person' })
    const reply = { chat: '42', user: '42', id: 7, replyTo: 1, text: '只解释 B，别执行。`touch /tmp/wrong` $(date)' }
    await bridge.inbound(reply)
    await Bun.sleep(20)
    expect(prompts).toHaveLength(0)
    busy = false
    await bridge.drain()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(JSON.stringify(reply.text))
    expect(prompts[0]).toContain('v2')
    await bridge.inbound(reply)
    await bridge.drain()
    expect(prompts).toHaveLength(1)
    const receiptLine = prompts[0]!.split('\n').find(l => l.startsWith('id='))!
    const receipt = receiptLine.split('receipt=')[1]
    expect((await bridge.http(request('/mesh/reply', { id: '42:7', receipt: 'wrong', text: 'no' }, false))).status).toBe(403)
    expect((await bridge.http(request('/mesh/reply', { id: '42:7', receipt, text: '方案 B 的区别是……尚未执行。' }, false))).status).toBe(200)
    expect(sent[1]!.reply).toBe(7)
    await bridge.http(request('/mesh/reply', { id: '42:7', receipt, text: 'duplicate' }, false))
    expect(sent).toHaveLength(2)
    await bridge.inbound({ chat: '42', user: '42', id: 8, replyTo: 2, text: '那 A 呢？' })
    await Bun.sleep(20)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('方案 B 的区别')
    const status = await (await bridge.http(request('/mesh/status', {}))).json()
    expect(status.deliveries[0].state).toBe('replied')
  } finally { bridge.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('stale destinations never receive a prompt; uncertain delivery survives restart without replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-test-'))
  const key = 'y'.repeat(32)
  const route = { label: 'A', herdr: '/herdr', session: 'default', agent: 'a', terminal_id: 'term1', callback: 'http://localhost:3500' }
  writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ user_id: '42', chat_id: '42', api_key: key, routes: { a: route } }))
  let terminal = 'term1', count = 0
  const sent: string[] = []
  const send = async (_chat: string, text: string) => { sent.push(text); return sent.length }
  const command = async (_route: unknown, args: string[]) => {
    if (args[0] === 'get') return { result: { agent: { terminal_id: terminal, agent_status: 'idle' } } }
    count++; throw Error('connection lost after possible delivery')
  }
  let bridge = createMeshBridge(dir, send, command)
  try {
    const notify = () => bridge.http(new Request('http://localhost/mesh/notify', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ route: 'a', issue: 'https://github.com/o/r/issues/1', version: 'v1', text: 'test' }) }))
    await notify()
    terminal = 'term2'
    await bridge.inbound({ chat: '42', user: '42', id: 4, replyTo: 1, text: 'test stale' })
    await Bun.sleep(20)
    expect(count).toBe(0)
    terminal = 'term1'
    await notify()
    await bridge.inbound({ chat: '42', user: '42', id: 5, replyTo: 3, text: 'test uncertain' })
    await Bun.sleep(20)
    expect(count).toBe(1)
    bridge.close()
    bridge = createMeshBridge(dir, send, command)
    await bridge.drain()
    expect(count).toBe(1)
  } finally { bridge.close(); rmSync(dir, { recursive: true, force: true }) }
})
