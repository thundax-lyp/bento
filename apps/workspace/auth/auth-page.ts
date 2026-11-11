export const authStyles = `
:root { font: 16px/1.55 system-ui, sans-serif; color: #1f3026; background: #e9eee8; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
main { width: min(26rem, calc(100% - 5rem)); padding: 2rem; border: 1px solid #d4ddd4; border-radius: 1rem; background: #fff; }
h1 { margin: .6rem 0; line-height: 1.2; }
.brand { font-weight: 750; letter-spacing: .1em; }
.action, button { display: inline-block; margin: .6rem 0; padding: .55rem 1rem; border: 0; border-radius: .45rem; background: #315941; color: #fff; text-decoration: none; font: inherit; cursor: pointer; }
form + form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #d4ddd4; }
`;

export function authPage(signedIn: boolean) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bento · ${signedIn ? '账号设置' : '登录'}</title>
<link rel="stylesheet" href="/auth/style.css"></head><body><main>
<p class="brand">BENTO</p>
${
    signedIn
        ? `<h1>账号设置</h1>
<a href="/">返回工作区</a>
<form method="post" action="/api/oidc/logout"><button>退出登录</button></form>
<form method="post" action="/api/oidc/close"><label><input type="checkbox" name="confirmed" value="yes" required> 确认注销 Bento 账号并清理项目</label><br>
<button>重新认证并注销账号</button></form>`
        : `<h1>登录工作区</h1>
<p>如果你收到了邀请，请先通过邮件中的链接完成注册和密码设置。</p>
<a class="action" href="/api/oidc/start">受邀用户登录</a>`
}
</main></body></html>`;
}
