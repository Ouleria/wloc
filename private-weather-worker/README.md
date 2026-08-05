# 菜菜私人天气与每日早安 Worker

这是一个独立项目，不修改 `cai.html`，也不会影响原有 WLOC 功能。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ouleria/wloc/tree/main/private-weather-worker)

## 一键部署

点击上面的按钮，登录 Cloudflare，部署时填写两个 Secret：

- `METEOMATICS_ICS_URL`：完整的 `webcal://...` Meteomatics 天气日历链接
- `ACCESS_TOKEN`：至少32位的私人随机密码

真实天气链接和密码不会写进 GitHub。

## 地址与功能

- `/daily`：完整早安、当前时间、8段天气、天气关心、星期文案、寒暑假判断
- `/weather`：只查看天气和关心提醒
- `/api/daily`：给 iPhone 捷径读取完整早安前半部分
- `/api/weather`：给 iPhone 捷径读取天气部分
- `/api/today`：兼容旧接口，等同 `/api/weather`
- `/api/preview`：带密码查看格式预览
- `/health`：只返回 `ok`

## 自动天气关心

- 自动识别凌晨、上午、下午、晚上下雨
- 多时段下雨、接近全天有雨、雷雨
- 33～34°C：天气较热
- 35°C及以上：高温加强提醒
- 16～18°C：转凉
- 11～15°C：明显冷
- 10°C及以下：非常冷提醒
- 当天最高与最低温差达到10°C时提醒

## 寒暑假

- 暑假：每年7月21日至8月31日，9月1日恢复上学文案
- 寒假：春节初一前7天开始，到农历正月初十结束
- 只在假期替换礼拜三、礼拜四的“考试加油”那一行
- 礼拜二保持原文，不添加考试文案

## iPhone 捷径

请求地址：

```text
https://你的Worker地址/api/daily
```

在“获取 URL 内容”中设置：

- 方法：`GET`
- 标头名称：`Authorization`
- 标头值：`Bearer 你的ACCESS_TOKEN`

`Bearer` 后面必须有一个英文空格。

然后继续获取：

```text
https://ssyya.cc/cai
```

最后署名继续由捷径自己添加，Worker不会重复添加。

## 修改文字

以后主要修改：

```text
src/config.js
```

星期文案、假期文案、天气关心文字、温度阈值都集中在这个文件顶部。只改引号内的文字或指定数字即可，不需要碰下面的解析程序。

## 隐私设计

- Meteomatics链接与访问密码只使用Cloudflare Secret
- 不把地址、坐标和原始订阅链接输出到网页或API
- 输出前再次过滤链接、坐标和订阅路径中的地点片段
- 网页禁止搜索引擎收录和第三方嵌入
- Worker日志默认关闭
- 网页密码只保存在当前标签页，关闭后消失

Cloudflare与Meteomatics仍然会参与请求处理；这里的“私人”是指不把地点、链接和结果公开给GitHub、搜索引擎或没有密码的普通访问者。
