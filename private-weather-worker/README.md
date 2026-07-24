# 私人天气 Worker（一键部署版）

这是一个独立的私人天气网页，不会修改或混入原来的 `cai.html`。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ouleria/wloc/tree/main/private-weather-worker)

## 最简单的用法

1. 点击上面的 **Deploy to Cloudflare** 按钮。
2. 登录并授权 Cloudflare 与 GitHub。
3. 在部署页面填写两个 Secret：
   - `METEOMATICS_ICS_URL`：粘贴 Meteomatics 生成的完整 `webcal://...` 链接。
   - `ACCESS_TOKEN`：填一个至少 32 位的随机私人密码。
4. 点击部署，完成后打开 Cloudflare 给出的 `workers.dev` 地址。
5. 在网页输入刚才的 `ACCESS_TOKEN`，即可查看今天的天气。

> 必须手动填写两个 Secret，这是为了不把住址、坐标和密码写进公开 GitHub。除此之外，代码、Worker、GitHub 仓库和自动部署都会由 Cloudflare 按钮处理。

## iPhone 捷径读取

请求地址：

```text
https://你的Worker地址/api/today
```

在“获取 URL 内容”中设置：

- 方法：`GET`
- 标头名称：`Authorization`
- 标头值：`Bearer 你的ACCESS_TOKEN`

`Bearer` 后面要有一个英文空格。

## 隐私设计

- 原始订阅链接和访问密码只使用 Cloudflare 加密 Secret，不写入源码。
- 网页与接口都禁止缓存；读取上游日历时也使用 `no-store`。
- Worker Observability 日志默认关闭。
- 忽略 iCalendar 的 `LOCATION`、`GEO` 等位置字段。
- 输出前再次过滤订阅链接中的地址、坐标、网址和常见街道地址格式。
- 网页禁止搜索引擎收录、第三方嵌入、定位、相机和麦克风权限。
- 密码只放在当前标签页的 `sessionStorage`，关闭标签页后会消失。

Cloudflare 仍然是这个 Worker 的运行服务商，网络请求会经过 Cloudflare；这里的“私人”是指不公开到 GitHub、网页、网址参数、搜索引擎或普通访问者。

## 自定义域名（可选）

先确认 `workers.dev` 地址工作正常，再到 Cloudflare：

**Worker → Settings → Domains & Routes → Add → Custom Domain**

例如：

```text
weather.example.com
```

之后网页地址为：

```text
https://weather.example.com/
```

## 自动更新

通过一键按钮部署后，Cloudflare 会把新仓库连接到 Worker。以后仓库代码有更新时，Cloudflare Workers Builds 会自动构建和部署。

## 手动部署（备用）

```bash
npm install
npm test
npm run check
npm run deploy
```

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars`，只在 `.dev.vars` 填真实 Secret。`.dev.vars` 已被 Git 忽略，不能上传。

## 接口

- `/`：私人天气网页
- `/api/today`：需要 `Authorization: Bearer ...` 的纯文字天气
- `/health`：只返回 `ok`，不读取天气和 Secret
- `/robots.txt`：禁止搜索引擎抓取

## 安全提醒

- 不要把真实 Meteomatics 链接放进 GitHub、截图、捷径分享页或网址参数。
- 不要把 `ACCESS_TOKEN` 分享给别人。
- 如果怀疑泄露，到 Cloudflare 的 **Settings → Variables and Secrets** 重新设置 Secret 并部署。
