/**
 * dsh-qqmail — QQ 邮箱 IMAP 只读插件
 *
 * 通过 IMAP over TLS 读取 QQ 邮箱，不引入任何第三方依赖。
 * 认证使用 QQ 邮箱的「IMAP 授权码」，而不是 QQ 登录密码。
 */

import tls from 'node:tls'
import z from '@deepseek-ai/schemastery'

const HOST = 'imap.qq.com'
const PORT = 993
const TIMEOUT_MS = 20000
const REF_EMAIL = 'QQMAIL_ADDRESS'
const REF_AUTH = 'QQMAIL_AUTH_CODE'

/* ------------------------------------------------------------------ */
/* 配置：DSH 设置页据此自动生成表单                                    */
/* ------------------------------------------------------------------ */

const authCodeField = (() => {
  const field = z.string().default('').description('IMAP 授权码（16 位字符），不是 QQ 登录密码')
  return typeof field.role === 'function' ? field.role('secret') : field
})()

export const Config = z.object({
  email: z.string().default('').description('QQ 邮箱地址，例如 someone@qq.com'),
  authCode: authCodeField,
})

let runtimeConfig = { email: '', authCode: '' }

/* ------------------------------------------------------------------ */
/* 最小 IMAP 客户端                                                    */
/* ------------------------------------------------------------------ */

function quote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

class ImapClient {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.seq = 0
    this.waiter = null
    this.closed = false
    this.socket = null
  }

  async open() {
    await new Promise((resolve, reject) => {
      const socket = tls.connect({ host: HOST, port: PORT, servername: HOST })
      this.socket = socket
      const fail = (err) => { this.closed = true; reject(err) }
      socket.once('error', fail)
      socket.once('secureConnect', () => { socket.removeListener('error', fail); resolve() })
      socket.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk])
        this.wake()
      })
      socket.on('error', () => { this.closed = true; this.wake() })
      socket.on('close', () => { this.closed = true; this.wake() })
      socket.setTimeout(TIMEOUT_MS, () => {
        this.closed = true
        socket.destroy(new Error('连接 imap.qq.com 超时'))
      })
    })
    const greeting = await this.readLine()
    if (!/^\*\s+OK/i.test(greeting)) throw new Error(`IMAP 握手失败: ${greeting}`)
  }

  wake() {
    const waiter = this.waiter
    if (waiter) { this.waiter = null; waiter() }
  }

  wait() {
    return new Promise((resolve) => { this.waiter = resolve })
  }

  async readLine() {
    for (;;) {
      const index = this.buf.indexOf('\r\n')
      if (index >= 0) {
        const line = this.buf.subarray(0, index).toString('latin1')
        this.buf = this.buf.subarray(index + 2)
        return line
      }
      if (this.closed) throw new Error('IMAP 连接已关闭')
      await this.wait()
    }
  }

  async readExact(size) {
    while (this.buf.length < size) {
      if (this.closed) throw new Error('IMAP 连接已关闭')
      await this.wait()
    }
    const out = this.buf.subarray(0, size)
    this.buf = this.buf.subarray(size)
    return out
  }

  async cmd(text) {
    if (!this.socket || this.closed) throw new Error('IMAP 连接已关闭')
    const tag = 'A' + String(++this.seq).padStart(4, '0')
    this.socket.write(`${tag} ${text}\r\n`)
    const items = []
    let line = await this.readLine()
    for (;;) {
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal) {
        const bytes = await this.readExact(Number(literal[1]))
        items.push({ line, literal: bytes })
        line = await this.readLine()
        continue
      }
      items.push({ line })
      if (line.startsWith(`${tag} `)) break
      line = await this.readLine()
    }
    const status = items[items.length - 1].line
    return { status, items }
  }

  async login(user, pass) {
    const { status } = await this.cmd(`LOGIN ${quote(user)} ${quote(pass)}`)
    if (!/^\S+\s+OK/i.test(status)) throw new Error(`登录被拒绝: ${status}`)
  }

  async sendId() {
    try { await this.cmd('ID ("name" "dsh-qqmail" "version" "0.1.0")') } catch { /* 服务器不支持时忽略 */ }
  }

  async status(mailbox) {
    const { items, status } = await this.cmd(`STATUS ${quote(mailbox)} (MESSAGES UNSEEN)`)
    if (!/^\S+\s+OK/i.test(status)) throw new Error(`无法读取邮箱状态: ${status}`)
    const line = items.map((item) => item.line).find((text) => /STATUS/i.test(text)) || ''
    const messages = /MESSAGES (\d+)/i.exec(line)
    const unseen = /UNSEEN (\d+)/i.exec(line)
    return { messages: messages ? Number(messages[1]) : 0, unseen: unseen ? Number(unseen[1]) : 0 }
  }

  async examine(mailbox) {
    const { status } = await this.cmd(`EXAMINE ${quote(mailbox)}`)
    if (!/^\S+\s+OK/i.test(status)) throw new Error(`无法打开邮箱「${mailbox}」: ${status}`)
  }

  async uidSearch(criteria) {
    const { items, status } = await this.cmd(`UID SEARCH ${criteria}`)
    if (!/^\S+\s+OK/i.test(status)) throw new Error(`搜索失败: ${status}`)
    const line = items.map((item) => item.line).find((text) => /^\*\s+SEARCH/i.test(text))
    if (!line) return []
    return line.replace(/^\*\s+SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean).map(Number)
  }

  async fetch(uids, what) {
    if (uids.length === 0) return []
    const { items } = await this.cmd(`UID FETCH ${uids.join(',')} ${what}`)
    const messages = []
    for (const item of items) {
      if (!item.literal) continue
      const uid = Number((/UID (\d+)/i.exec(item.line) || [])[1])
      const flags = (/FLAGS \(([^)]*)\)/i.exec(item.line) || [null, ''])[1]
      messages.push({ uid, flags, payload: item.literal })
    }
    return messages
  }

  async close() {
    try { await this.cmd('LOGOUT') } catch { /* 忽略关闭错误 */ }
    try { this.socket?.destroy() } catch { /* 忽略 */ }
    this.closed = true
  }
}

/* ------------------------------------------------------------------ */
/* MIME 解析                                                           */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parseHeaders(text) {
  const headers = {}
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '') continue
    if (/^[ \t]/.test(raw) && current) {
      headers[current] += ' ' + raw.trim()
      continue
    }
    const colon = raw.indexOf(':')
    if (colon < 0) continue
    current = raw.slice(0, colon).trim().toLowerCase()
    headers[current] = raw.slice(colon + 1).trim()
  }
  return headers
}

function getParam(headerValue, name) {
  if (!headerValue) return undefined
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i')
  const match = pattern.exec(headerValue)
  if (!match) return undefined
  return match[2] !== undefined ? match[2] : match[1]
}

function decodeWords(text) {
  if (!text) return ''
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, payload) => {
    try {
      let buf
      if (encoding.toUpperCase() === 'B') {
        buf = Buffer.from(payload, 'base64')
      } else {
        const bytes = []
        const expanded = payload.replace(/_/g, ' ')
        for (let i = 0; i < expanded.length; i += 1) {
          if (expanded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(expanded.slice(i + 1, i + 3))) {
            bytes.push(parseInt(expanded.slice(i + 1, i + 3), 16))
            i += 2
          } else {
            bytes.push(expanded.charCodeAt(i))
          }
        }
        buf = Buffer.from(bytes)
      }
      return new TextDecoder(charset).decode(buf)
    } catch {
      return whole
    }
  })
}

function decodeCharset(buf, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(buf) } catch { return buf.toString('utf8') }
}

function decodeQuotedPrintable(buf) {
  const out = []
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x3d) {
      if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) { i += 2; continue }
      const hex = String.fromCharCode(buf[i + 1] || 32, buf[i + 2] || 32)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue }
    }
    out.push(buf[i])
  }
  return Buffer.from(out)
}

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodePart(headers, bodyText) {
  const encoding = (headers['content-transfer-encoding'] || '').toLowerCase().trim()
  let buf = Buffer.from(bodyText, 'latin1')
  if (encoding === 'base64') buf = Buffer.from(bodyText.replace(/\s+/g, ''), 'base64')
  else if (encoding === 'quoted-printable') buf = decodeQuotedPrintable(buf)
  const charset = getParam(headers['content-type'] || '', 'charset') || 'utf-8'
  return decodeCharset(buf, charset)
}

function extractText(headers, bodyText) {
  const contentType = (headers['content-type'] || 'text/plain').toLowerCase()
  if (contentType.startsWith('multipart/')) {
    const boundary = getParam(headers['content-type'], 'boundary')
    if (!boundary) return ''
    let plain = ''
    let html = ''
    for (const rawPart of bodyText.split(`--${boundary}`)) {
      const part = rawPart.replace(/^[\r\n]+/, '')
      if (!part || part.startsWith('--')) continue
      const split = part.search(/\r?\n\r?\n/)
      if (split < 0) continue
      const partHeaders = parseHeaders(part.slice(0, split))
      const partBody = part.slice(split).replace(/^\r?\n\r?\n/, '')
      const text = extractText(partHeaders, partBody)
      if (!text) continue
      const partType = (partHeaders['content-type'] || 'text/plain').toLowerCase()
      if (partType.startsWith('text/html')) { if (!html) html = text } else if (!plain) plain = text
    }
    return plain || html
  }
  if (contentType.startsWith('text/html')) return stripHtml(decodePart(headers, bodyText))
  return decodePart(headers, bodyText)
}

function parseMessage(payload) {
  const text = payload.toString('latin1')
  const split = text.search(/\r?\n\r?\n/)
  const headerText = split < 0 ? text : text.slice(0, split)
  const bodyText = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '')
  const headers = parseHeaders(headerText)
  return { headers, body: extractText(headers, bodyText) }
}

function imapDate(date) {
  return `${String(date.getDate()).padStart(2, '0')}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`
}

/* ------------------------------------------------------------------ */
/* 连接与凭据                                                          */
/* ------------------------------------------------------------------ */

async function readCredentials(ctx) {
  // 1) 设置页写入的配置优先
  if (runtimeConfig.email && runtimeConfig.authCode) {
    return { email: runtimeConfig.email, auth: runtimeConfig.authCode }
  }
  // 2) 回退到凭据服务（qqmail_setup 工具写入的）
  const email = await ctx.credentials.resolve(REF_EMAIL)
  const auth = await ctx.credentials.resolve(REF_AUTH)
  if (!email || !auth) return undefined
  return { email: email.value, auth: auth.value }
}

async function withSession(ctx, fn) {
  const creds = await readCredentials(ctx)
  if (!creds) {
    throw new Error('QQ 邮箱尚未配置。请先调用 qqmail_setup，提供邮箱地址和 IMAP 授权码。')
  }
  const client = new ImapClient()
  await client.open()
  try {
    await client.login(creds.email, creds.auth)
    await client.sendId()
    return await fn(client, creds)
  } finally {
    await client.close()
  }
}

/* ------------------------------------------------------------------ */
/* 设置页的宿主接口                                                    */
/* ------------------------------------------------------------------ */

const SETTINGS_ROUTE = '/dsh-qqmail/settings'

async function verifyLogin(email, authCode) {
  const client = new ImapClient()
  await client.open()
  try {
    await client.login(email, authCode)
    await client.sendId()
    return await client.status('INBOX')
  } finally {
    await client.close()
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

async function handleSettings(ctx, req, res) {
  // 只接受同源请求，避免其它站点驱动这个浏览器端接口
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        sendJson(res, 403, { ok: false, error: '仅允许同源请求' })
        return
      }
    } catch {
      sendJson(res, 403, { ok: false, error: '请求来源不合法' })
      return
    }
  }

  if (req.method === 'GET') {
    const creds = await readCredentials(ctx)
    sendJson(res, 200, creds ? { configured: true, email: creds.email } : { configured: false })
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 GET 和 POST' })
    return
  }

  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    sendJson(res, 415, { ok: false, error: '需要 application/json' })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
    return
  }

  const email = String(body?.email ?? '').trim()
  const authCode = String(body?.authCode ?? '').trim()
  const action = body?.action === 'test' ? 'test' : 'save'

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    sendJson(res, 400, { ok: false, error: '邮箱地址格式不正确' })
    return
  }
  if (authCode.length < 6) {
    sendJson(res, 400, { ok: false, error: '授权码看起来不完整' })
    return
  }

  let info
  try {
    info = await verifyLogin(email, authCode)
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      error: `登录验证失败：${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }

  if (action === 'save') {
    await ctx.credentials.set(REF_EMAIL, email)
    await ctx.credentials.set(REF_AUTH, authCode)
    runtimeConfig = { email, authCode }
  }

  sendJson(res, 200, { ok: true, messages: info.messages, unseen: info.unseen })
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

export { ImapClient, parseHeaders, decodeWords, parseMessage, extractText }

const textOutput = (schema) => ({
  schema,
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  },
})

function register(ctx, definition) {
  ctx.effect(() => ctx.tools.register(definition))
}

export const inject = ['tools', 'credentials']

export function apply(ctx, config = {}) {
  runtimeConfig = {
    email: String(config?.email ?? '').trim(),
    authCode: String(config?.authCode ?? '').trim(),
  }

  // 设置页的宿主路由（浏览器端 client.js 调用）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => {
          handleSettings(ctx, req, res).catch((error) => {
            try {
              sendJson(res, 500, { ok: false, error: String(error?.message || error) })
            } catch { /* 响应已发出 */ }
          })
        },
      }), 'dsh-qqmail: settings route')
    })
  }

  register(ctx, {
    name: 'qqmail_status',
    description:
      '检查 QQ 邮箱是否已配置并能正常登录，返回邮箱地址、邮件总数和未读数。首次使用前先用它确认配置状态。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput({
      type: 'object',
      properties: {
        configured: { type: 'boolean' },
        email: { type: 'string' },
        messages: { type: 'integer' },
        unseen: { type: 'integer' },
      },
    }),
    timeoutMs: 45000,
    async execute() {
      const creds = await readCredentials(ctx)
      if (!creds) return { configured: false, hint: '调用 qqmail_setup 配置邮箱地址与授权码' }
      const info = await withSession(ctx, (client) => client.status('INBOX'))
      return { configured: true, email: creds.email, messages: info.messages, unseen: info.unseen }
    },
  })

  register(ctx, {
    name: 'qqmail_inbox',
    description:
      '列出最近收到的邮件，可按未读筛选。返回每封邮件的 uid、发件人、主题、日期和是否已读；用 uid 配合 qqmail_read 读取正文。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: '返回的最大邮件数' },
        unseenOnly: { type: 'boolean', default: false, description: '只返回未读邮件' },
        mailbox: { type: 'string', default: 'INBOX', description: '邮箱文件夹名，默认收件箱' },
      },
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      properties: {
        mailbox: { type: 'string' },
        messages: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean' },
      },
    }),
    timeoutMs: 60000,
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50)
      const unseenOnly = Boolean(args?.unseenOnly)
      const mailbox = String(args?.mailbox || 'INBOX')
      return withSession(ctx, async (client) => {
        await client.examine(mailbox)
        const uids = await client.uidSearch(unseenOnly ? 'UNSEEN' : 'ALL')
        const recent = uids.slice(-limit).reverse()
        const fetched = await client.fetch(recent, '(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
        const messages = fetched.map((message) => {
          const headers = parseHeaders(message.payload.toString('latin1'))
          return {
            uid: message.uid,
            from: decodeWords(headers.from || ''),
            subject: decodeWords(headers.subject || '(无主题)'),
            date: headers.date || '',
            seen: message.flags.includes('\\Seen'),
          }
        })
        return { mailbox, messages, truncated: uids.length > recent.length }
      })
    },
  })

  register(ctx, {
    name: 'qqmail_read',
    description: '按 uid 读取一封邮件的正文，返回发件人、主题、日期和纯文本内容（超出长度会截断并标注）。',
    parameters: {
      type: 'object',
      properties: {
        uid: { type: 'integer', minimum: 1, description: '邮件 uid，来自 qqmail_inbox 或 qqmail_search' },
        maxChars: { type: 'integer', minimum: 200, maximum: 20000, default: 4000, description: '正文最多返回的字符数' },
      },
      required: ['uid'],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      properties: {
        uid: { type: 'integer' },
        from: { type: 'string' },
        subject: { type: 'string' },
        date: { type: 'string' },
        body: { type: 'string' },
        truncated: { type: 'boolean' },
      },
    }),
    timeoutMs: 60000,
    async execute(args) {
      const uid = Number(args?.uid)
      const maxChars = Math.min(Math.max(Number(args?.maxChars) || 4000, 200), 20000)
      if (!Number.isInteger(uid) || uid < 1) throw new Error('uid 必须是正整数')
      return withSession(ctx, async (client) => {
        await client.examine('INBOX')
        const [message] = await client.fetch([uid], '(UID BODY.PEEK[])')
        if (!message) throw new Error(`找不到 uid 为 ${uid} 的邮件`)
        const parsed = parseMessage(message.payload)
        const body = parsed.body.trim()
        return {
          uid,
          from: decodeWords(parsed.headers.from || ''),
          subject: decodeWords(parsed.headers.subject || '(无主题)'),
          date: parsed.headers.date || '',
          body: body.length > maxChars ? body.slice(0, maxChars) + '\n\n[内容已截断]' : body,
          truncated: body.length > maxChars,
        }
      })
    },
  })

  register(ctx, {
    name: 'qqmail_search',
    description: '在邮箱中搜索邮件，支持按关键词（主题/发件人/正文）和起始日期过滤。返回 uid 列表，可再用 qqmail_read 看正文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，匹配主题、发件人或正文' },
        from: { type: 'string', description: '按发件人地址或名称过滤' },
        since: { type: 'string', description: '起始日期，格式 YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: '返回的最大邮件数' },
      },
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      properties: {
        messages: { type: 'array', items: { type: 'object' } },
        matched: { type: 'integer' },
      },
    }),
    timeoutMs: 60000,
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 50)
      const criteria = []
      if (args?.query) criteria.push(`TEXT ${quote(args.query)}`)
      if (args?.from) criteria.push(`FROM ${quote(args.from)}`)
      if (args?.since) {
        const date = new Date(`${args.since}T00:00:00`)
        if (Number.isNaN(date.getTime())) throw new Error('since 需要 YYYY-MM-DD 格式')
        criteria.push(`SINCE ${imapDate(date)}`)
      }
      if (criteria.length === 0) throw new Error('至少提供 query、from、since 之一')
      return withSession(ctx, async (client) => {
        await client.examine('INBOX')
        const uids = await client.uidSearch(criteria.join(' '))
        const recent = uids.slice(-limit).reverse()
        const fetched = await client.fetch(recent, '(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
        const messages = fetched.map((message) => {
          const headers = parseHeaders(message.payload.toString('latin1'))
          return {
            uid: message.uid,
            from: decodeWords(headers.from || ''),
            subject: decodeWords(headers.subject || '(无主题)'),
            date: headers.date || '',
            seen: message.flags.includes('\\Seen'),
          }
        })
        return { messages, matched: uids.length }
      })
    },
  })

  register(ctx, {
    name: 'qqmail_setup',
    description:
      '保存 QQ 邮箱地址与 IMAP 授权码，并立即验证能否登录。也可以在「设置 → 插件 → QQ 邮箱」里填写，效果相同。授权码在 QQ 邮箱「设置 → 账户 → POP3/IMAP 服务」中生成，不是 QQ 密码。',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: '完整邮箱地址，如 someone@qq.com' },
        authCode: { type: 'string', description: 'IMAP 授权码，通常为 16 位字符' },
      },
      required: ['email', 'authCode'],
      additionalProperties: false,
    },
    output: textOutput({
      type: 'object',
      properties: {
        saved: { type: 'boolean' },
        email: { type: 'string' },
        messages: { type: 'integer' },
        unseen: { type: 'integer' },
      },
    }),
    timeoutMs: 60000,
    async execute(args) {
      const email = String(args?.email || '').trim()
      const authCode = String(args?.authCode || '').trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('邮箱地址格式不正确')
      if (authCode.length < 6) throw new Error('授权码看起来不完整')

      const client = new ImapClient()
      await client.open()
      let info
      try {
        await client.login(email, authCode)
        await client.sendId()
        info = await client.status('INBOX')
      } catch (error) {
        await client.close()
        throw new Error(`登录验证失败，未保存：${error instanceof Error ? error.message : String(error)}`)
      }
      await client.close()

      await ctx.credentials.set(REF_EMAIL, email)
      await ctx.credentials.set(REF_AUTH, authCode)
      return { saved: true, email, messages: info.messages, unseen: info.unseen }
    },
  })
}
