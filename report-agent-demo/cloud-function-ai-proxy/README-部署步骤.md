# 智谱 AI 中转云函数 · 部署步骤

本云函数作用：接收前端算好的统计摘要（纯数字结构，不含任何上传数据原文），带着智谱 API Key 去调用 GLM-4-Flash，生成分析文案，再把文案返回给前端。**Key 只存在于云函数环境变量里，不会出现在任何前端代码或公网可见文件中。**

支持两种调用模式（与前端契约一致）：
- **首次生成**：`POST {stats, instruction?}` —— 基于统计摘要生成报告文案，可附带额外要求。
- **对话改写**：`POST {stats, currentReport, instruction}` —— 基于已有报告正文 + 修改指令，输出修订后的完整报告。

## 一、创建云函数

1. 打开腾讯云函数控制台：<https://console.cloud.tencent.com/scf>
2. 点击「新建」
3. 选择：
   - **创建方式**：自定义创建
   - **函数名称**：`ai-report-narrative-proxy`（或你喜欢的名字）
   - **地域**：建议选上海（跟你现有的 CloudBase 服务同区域，访问更快）
   - **运行环境**：`Node.js 16.13` 或更高版本
   - **提交方法**：在线编辑（函数代码体量很小，直接粘贴即可）
4. 把本目录下 `index.js` 的全部内容粘贴进在线编辑器，覆盖默认代码
5. **执行方法**（Handler）填：`index.main_handler`

## 二、配置环境变量（最关键的一步，Key 存在这里）

在创建页面或创建后的函数详情页，找到「函数配置」→「环境变量」，添加两条：

| 键 | 值 | 说明 |
|---|---|---|
| `ZHIPU_API_KEY` | 你的智谱 API Key | **不要**写在代码里，只能写在这里 |
| `ALLOWED_ORIGIN` | `https://yiru220.github.io` | 允许跨域访问的来源，就填你的报告工具部署的域名（GitHub Pages 是 yiru220.github.io，别填已下线的 health-cabin.cn） |

## 三、配置触发器（让它能被 HTTP 调用）

1. 函数详情页 → 「触发管理」→「创建触发器」
2. 触发方式选 **API 网关触发器**
3. 关键配置：
   - **鉴权方式**：选 **免鉴权**（因为前端是纯静态页面直接 fetch，不走云 API 的签名鉴权；如果你担心被滥用，后续可以加频率限制）
   - **请求方法**：ANY（这样 OPTIONS 预检请求和 POST 都能过）
   - **集成响应**：**开启**（必须开启，否则云函数返回的 statusCode 和 headers 不会生效，前端会收到奇怪的响应）
4. 创建完成后，触发器列表会给你一个形如下面的访问地址，复制下来：
   ```
   https://service-xxxxxxxx-1234567890.ap-shanghai.apigateway.myqcloud.com/release/ai-report-narrative-proxy
   ```

## 四、把这个地址告诉我（或自己填进前端代码）

前端 `app.js` 里已经预留了配置项：

```javascript
const AI_PROXY_ENDPOINT = ""; // 把第三步拿到的 API 网关地址填在这里
```

找到 `app.js` 里这一行，把触发器地址填进去，保存后重新部署前端即可。

## 五、测试

部署完成后，用这段命令测试云函数是否正常工作（把 URL 换成你自己的触发器地址）：

```bash
curl -X POST https://你的触发器地址 \
  -H "Content-Type: application/json" \
  -d '{"stats": {"summary": {"销售额": {"sum": 100000, "mean": 5000}}, "trend": null, "ranking": null}}'
```

正常返回应该类似：

```json
{"ok": true, "narrative": "……AI生成的分析文案……"}
```

如果返回 `{"ok": false, "error": "..."}`，根据 error 信息排查：
- `服务端未配置 ZHIPU_API_KEY` → 环境变量没填或没保存
- `智谱接口返回状态码 401` → Key 不对或者已过期/欠费
- `智谱接口返回状态码 429` → 调用频率超限，智谱有免费额度限制

## 六、费用提示

- 腾讯云函数本身有免费额度（每月 100万次调用 + 40万 GBs 资源使用量），这种低频调用的场景基本不会产生费用
- 智谱 GLM-4-Flash 目前（截至部署时）对个人开发者有免费调用额度，具体以智谱官方最新计费页面为准，建议部署后去 <https://open.bigmodel.cn/usercenter/financing> 关注一下用量，避免超额产生费用
