# 智谱 AI 中转 Worker · Cloudflare 部署步骤

本 Worker 作用：接收前端算好的统计摘要（纯数字结构，不含任何上传数据原文），带着智谱 API Key 去调用 GLM-4-Flash，生成分析文案，再把文案返回给前端。**Key 只存在于 Cloudflare 的 Secret 环境变量里，不会出现在任何前端代码、GitHub 仓库或 worker.js 源文件中。**

全程只需要浏览器操作，不需要安装任何命令行工具。

## 一、注册 / 登录 Cloudflare

1. 打开 <https://dash.cloudflare.com/>，没有账号就免费注册一个（邮箱即可，不需要绑卡）
2. 登录后左侧菜单找到 **Workers 和 Pages**（或者首页搜索 "Workers"）

## 二、创建 Worker

1. 点击 **创建应用程序** → **创建 Worker**
2. 给 Worker 起个名字，比如 `ai-report-narrative-proxy`（这会成为访问地址的一部分）
3. 点击 **部署**，会先生成一个默认的 "Hello World" Worker，没关系，下一步替换代码

## 三、替换代码

1. 部署完成后点击 **编辑代码**（或者进入该 Worker 详情页，点 "Quick Edit" / "编辑代码"）
2. 把编辑器里默认的代码全部删掉，粘贴本目录下 `worker.js` 的全部内容
3. 点击右上角 **部署** / **保存并部署**

## 四、配置环境变量（最关键的一步，Key 存在这里）

1. 回到 Worker 详情页，找到 **设置** → **变量和机密**（Variables and Secrets）
2. 添加两个变量：

| 变量名 | 值 | 类型 |
|---|---|---|
| `ZHIPU_API_KEY` | 你的智谱 API Key | 选择 **Secret**（加密存储，不是普通文本变量，这样页面上也不会显示明文） |
| `ALLOWED_ORIGIN` | `https://yiru220.github.io` | 普通变量（Text），用于 CORS，填你的 GitHub Pages 域名 |

3. 保存后 Worker 会自动重新部署生效

## 五、拿到访问地址

部署成功后，Worker 详情页会显示一个形如下面的地址：

```
https://ai-report-narrative-proxy.你的用户名.workers.dev
```

这个就是前端要调用的地址，**是永久地址，不会随每次部署变化**（这点跟 EdgeOne 预览链接不一样，可以放心长期使用）。

## 六、把这个地址告诉我

把第五步拿到的 `*.workers.dev` 地址发给我，我会把它填进前端 `app.js` 里的：

```javascript
const AI_PROXY_ENDPOINT = "";
```

填好后重新推送到 GitHub 仓库即可生效。

## 七、测试（可选，确认 Worker 本身工作正常）

部署完成后，可以用浏览器直接访问这个地址测试（会返回 405，因为浏览器默认发 GET 请求，而接口只接受 POST，但只要不是网络错误/超时就说明 Worker 已经跑起来了）：

```
https://ai-report-narrative-proxy.你的用户名.workers.dev
```

或者更严谨地用命令行测试（如果你电脑上有终端）：

```bash
curl -X POST https://ai-report-narrative-proxy.你的用户名.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"stats": {"summary": {"销售额": {"sum": 100000, "mean": 5000}}, "trend": null, "ranking": null}}'
```

正常返回应该类似：

```json
{"ok": true, "narrative": "……AI生成的分析文案……"}
```

如果返回 `{"ok": false, "error": "..."}`，根据 error 信息排查：
- `服务端未配置 ZHIPU_API_KEY` → Secret 没填或没保存成功
- `智谱接口返回状态码 401` → Key 不对或者已过期/欠费
- `智谱接口返回状态码 429` → 调用频率超限，智谱有免费额度限制

## 八、费用提示

Cloudflare Workers 免费版额度：每天 10 万次请求，足够这种演示场景使用，正常不会产生费用。智谱 GLM-4-Flash 的免费额度以智谱官方最新计费页面为准，建议部署后去 <https://open.bigmodel.cn/usercenter/financing> 关注一下用量。
