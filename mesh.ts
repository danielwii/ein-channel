#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Keep credentials out of shell arguments and agent output. Notification input
// is a JSON file: {route, issue, version, text}; no Telegram token is exposed.
const directory = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude/channels/telegram')
const config = JSON.parse(readFileSync(join(directory, 'mesh.json'), 'utf8'))
const [action, input] = process.argv.slice(2)
if (!['notify', 'status'].includes(action ?? '') || (action === 'notify' && !input)) {
  console.error('Usage: bun mesh.ts notify <notification.json> | status')
  process.exit(1)
}
const response = await fetch(`http://127.0.0.1:${process.env.EIN_CHANNEL_PORT ?? '3500'}/mesh/${action}`, {
  method: 'POST', headers: { authorization: `Bearer ${config.api_key}`, 'content-type': 'application/json' },
  body: action === 'notify' ? readFileSync(input!, 'utf8') : '{}',
})
console.log(await response.text())
if (!response.ok) process.exit(1)
