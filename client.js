/**
 * dsh-qqmail 的浏览器端：在「设置」里注册一个 QQ 邮箱配置页。
 * 通过同源 HTTP 路由 /dsh-qqmail/settings 与宿主通信。
 */
window.__ModuleLoader__.load({
  id: '@qhao/dsh-qqmail',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ROUTE = '/dsh-qqmail/settings'

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 },
      intro: { margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.75 },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 13, fontWeight: 500 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.38)',
        background: 'transparent',
        color: 'inherit',
        outline: 'none',
      },
      hint: { fontSize: 12, opacity: 0.6, lineHeight: 1.5 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: {
        padding: '7px 14px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.38)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        padding: '7px 14px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid transparent',
        background: '#1a7cf0',
        color: '#fff',
        cursor: 'pointer',
      },
      status: { fontSize: 12.5, lineHeight: 1.6 },
    }

    function QQMailSection() {
      const [email, setEmail] = React.useState('')
      const [authCode, setAuthCode] = React.useState('')
      const [configured, setConfigured] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [status, setStatus] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        fetch(ROUTE, { credentials: 'same-origin', cache: 'no-store' })
          .then((response) => response.json())
          .then((data) => {
            if (cancelled) return
            setConfigured(Boolean(data?.configured))
            if (data?.email) setEmail(data.email)
          })
          .catch(() => { /* 首次打开时宿主可能还没就绪，忽略 */ })
        return () => { cancelled = true }
      }, [])

      async function submit(action) {
        if (!email.trim() || !authCode.trim()) {
          setStatus({ ok: false, text: '请先填写邮箱地址和授权码' })
          return
        }
        setBusy(action)
        setStatus(null)
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, email: email.trim(), authCode: authCode.trim() }),
          })
          const data = await response.json()
          if (data?.ok) {
            setConfigured(true)
            if (action === 'save') setAuthCode('')
            setStatus({
              ok: true,
              text: `连接成功：共 ${data.messages} 封邮件，${data.unseen} 封未读` + (action === 'save' ? '（已保存）' : '（仅测试，未保存）'),
            })
          } else {
            setStatus({ ok: false, text: data?.error || '连接失败' })
          }
        } catch (error) {
          setStatus({ ok: false, text: '请求失败：' + String(error?.message || error) })
        } finally {
          setBusy('')
        }
      }

      const disabled = busy !== ''
      return h('div', { style: styles.wrap },
        h('p', { style: styles.intro },
          configured
            ? '已配置。修改后点保存即可生效。'
            : '填写 QQ 邮箱地址和 IMAP 授权码。授权码在 QQ 邮箱「设置 → 账户 → POP3/IMAP 服务」中生成，不是 QQ 登录密码。'),
        h('div', { style: styles.field },
          h('label', { style: styles.label }, 'QQ 邮箱地址'),
          h('input', {
            style: styles.input,
            type: 'email',
            value: email,
            placeholder: 'someone@qq.com',
            autoComplete: 'off',
            onChange: (event) => setEmail(event.target.value),
          }),
        ),
        h('div', { style: styles.field },
          h('label', { style: styles.label }, 'IMAP 授权码'),
          h('input', {
            style: styles.input,
            type: 'password',
            value: authCode,
            placeholder: configured ? '已保存，如需修改请重新输入' : '16 位授权码',
            autoComplete: 'off',
            onChange: (event) => setAuthCode(event.target.value),
          }),
          h('span', { style: styles.hint }, '授权码只用于登录 imap.qq.com，存进凭据服务，不会显示在界面上。'),
        ),
        h('div', { style: styles.row },
          h('button', {
            style: styles.primary,
            disabled,
            onClick: () => submit('save'),
          }, busy === 'save' ? '验证中…' : '保存并验证'),
          h('button', {
            style: styles.button,
            disabled,
            onClick: () => submit('test'),
          }, busy === 'test' ? '测试中…' : '仅测试连接'),
        ),
        status
          ? h('div', { style: { ...styles.status, color: status.ok ? '#1a9e57' : '#d64545' } }, status.text)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const label = () => {
          try {
            const snapshot = ctx.locale?.getSnapshot?.()
            if (snapshot && snapshot.active && String(snapshot.active).toLowerCase().startsWith('en')) return 'QQ Mail'
          } catch { /* 忽略 */ }
          return 'QQ 邮箱'
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qqmail',
          order: 35,
          label,
        }, QQMailSection))
      },
    }
  },
})
