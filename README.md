# dsh-qqmail

Read a QQ Mail inbox from DeepSeek Harness over IMAP, using the mailbox's authorization code.

在 DeepSeek Harness 里通过 IMAP 读取 QQ 邮箱，使用邮箱授权码登录。

## What it does

A Host plugin with five agent tools and one settings page. Everything is read-only: it never sends,
deletes, moves, or marks a message as read.

- `qqmail_inbox` — list recent messages, optionally unread only.
- `qqmail_read` — read one message body by uid, decoded from base64, quoted-printable,
  GBK/UTF-8, and `multipart/alternative`.
- `qqmail_search` — search by keyword, sender, or a start date.
- `qqmail_status` — report the configured address, total messages, and unread count.
- `qqmail_setup` — save the address and authorization code from a tool call instead of the UI.

A settings page under **Settings → QQ Mail** (`settings.section`, id `qqmail`) takes the same two
values, verifies them against `imap.qq.com` before saving, and closes the loop with a live
"connection succeeded, N messages / M unread" result.

## Requirements

- DeepSeek Harness `>=0.2.1-rc.3`.
- A QQ Mail address with the IMAP service enabled, plus the 16-character authorization code.
  Generate it at QQ Mail → Settings → Account → POP3/IMAP service. It is not the QQ password.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-qqmail
```

Or straight from this repository:

```sh
dsh plugin --profile <your-profile> add github:Q-hao516/dsh-qqmail
```

There is no build step; the package ships its JavaScript as authored.

## Configure

Open **Settings → QQ Mail**, fill the address and authorization code, press 保存并验证
(save and verify). Nothing is stored until the login actually succeeds.

The authorization code is kept as a credential record, not as plaintext configuration, and the
settings form marks the field `secret`. The page talks to a same-origin route
(`/dsh-qqmail/settings`) that rejects cross-origin callers and non-JSON bodies.

## Limitations

- QQ Mail only. The IMAP host is fixed at `imap.qq.com:993`; there is no generic IMAP configuration.
- Read-only. No sending, replying, filtering, or attachment download.
- Header and body parsing covers the common cases above, not every MIME construct.

## Development

`node selftest.mjs` runs the MIME parsing cases and performs a real TLS handshake plus an
authentication attempt against `imap.qq.com` with a dummy credential, asserting the server's
rejection is parsed correctly. It needs network access and no account.

## License

MIT
