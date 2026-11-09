// 插件离线自测：MIME 解析 + 真实 IMAP 握手（不涉及账号）
import { ImapClient, parseHeaders, decodeWords, parseMessage } from './index.js'

let failures = 0
function check(name, actual, expected) {
  const ok = expected instanceof RegExp ? expected.test(String(actual)) : String(actual) === String(expected)
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `\n    实际: ${actual}\n    期望: ${expected}`}`)
  if (!ok) failures += 1
}

/* ---------- 1. 编码字解码 ---------- */
check('UTF-8 编码字', decodeWords('=?UTF-8?B?5rWL6K+V6YKu5Lu2?='), '测试邮件')
check('GBK 编码字', decodeWords('=?GBK?B?1tDOxA==?='), '中文')
check('Q 编码字', decodeWords('=?UTF-8?Q?Hello_World?='), 'Hello World')
check('普通文本不变', decodeWords('no encoding'), 'no encoding')

/* ---------- 2. 头部解析（含折行） ---------- */
const headers = parseHeaders([
  'From: "张三" <zhangsan@qq.com>',
  'Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=',
  'Date: Mon, 9 Nov 2026 10:00:00 +0800',
  'Content-Type: text/plain; charset="utf-8"',
].join('\r\n'))
check('From 解析', headers.from, '"张三" <zhangsan@qq.com>')
check('Subject 解码', decodeWords(headers.subject), '测试邮件')

const folded = parseHeaders('Subject: part one\r\n  part two\r\nFrom: a@b.c')
check('折行合并', folded.subject, 'part one part two')

/* ---------- 3. 纯文本 base64 正文 ---------- */
const plain = [
  'From: a@qq.com',
  'Subject: hi',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('你好，这是正文。', 'utf8').toString('base64'),
].join('\r\n')
check('base64 正文', parseMessage(Buffer.from(plain, 'utf8')).body.trim(), '你好，这是正文。')

/* ---------- 4. multipart 优先取 text/plain ---------- */
const boundary = 'BOUNDARY123'
const multipart = [
  'From: a@qq.com',
  'Subject: multi',
  `Content-Type: multipart/alternative; boundary="${boundary}"`,
  '',
  `--${boundary}`,
  'Content-Type: text/plain; charset="utf-8"',
  '',
  '纯文本内容',
  `--${boundary}`,
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<p>HTML 内容</p>',
  `--${boundary}--`,
  '',
].join('\r\n')
check('multipart 取纯文本', parseMessage(Buffer.from(multipart, 'utf8')).body.trim(), '纯文本内容')

/* ---------- 5. 只有 HTML 时去标签 ---------- */
const htmlOnly = [
  'From: a@qq.com',
  'Content-Type: text/html; charset="utf-8"',
  '',
  '<div>第一行</div><div>第二行</div>',
].join('\r\n')
const htmlText = parseMessage(Buffer.from(htmlOnly, 'utf8')).body
check('HTML 去标签', /第一行[\s\S]*第二行/.test(htmlText), true)

/* ---------- 6. quoted-printable ---------- */
const qp = [
  'From: a@qq.com',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '=E4=BD=A0=E5=A5=BD',
].join('\r\n')
check('QP 解码', parseMessage(Buffer.from(qp, 'utf8')).body.trim(), '你好')

/* ---------- 7. 真实 IMAP 握手 + 假凭据登录 ---------- */
const client = new ImapClient()
try {
  await client.open()
  console.log('✔ 连接 imap.qq.com:993 并收到服务器问候')
  try {
    await client.login('dsh-probe@qq.com', 'invalid-auth-code-0')
    console.log('✘ 假凭据竟然登录成功？')
    failures += 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ok = /登录被拒绝|^\S+\s+(NO|BAD)/i.test(message)
    console.log(`${ok ? '✔' : '✘'} 假凭据被服务器拒绝，响应解析正常\n    ${message}`)
    if (!ok) failures += 1
  }
} catch (error) {
  console.log(`✘ IMAP 连接失败: ${error instanceof Error ? error.message : String(error)}`)
  failures += 1
} finally {
  await client.close()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
