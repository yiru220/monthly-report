/**
 * Cloudflare Worker —— 智谱 GLM-4-Flash 分析文案生成中转层
 *
 * 作用：
 *   前端把"统计分析结果"（纯数字结构，不含敏感信息）POST 到这个 Worker，
 *   Worker 带着环境变量（Secret）里的智谱 API Key 去调用 GLM-4-Flash，让 AI 把数字
 *   组织成自然语言分析文案，再把文案返回给前端。
 *
 * 安全要点：
 *   - API Key 存在 Cloudflare 的 Secret 环境变量 ZHIPU_API_KEY 里，不会出现在任何
 *     前端代码、GitHub 仓库、或者这个 worker.js 源文件里
 *   - Worker 本身不碰用户上传的原始 Excel 数据，只处理前端已经算好的统计摘要
 *   - 对输入做基本校验，避免被滥用塞入超大 payload
 *
 * 部署方式见同目录下 README-部署步骤.md（纯网页控制台操作，不需要安装任何命令行工具）
 */

const ZHIPU_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const MAX_BODY_BYTES = 50 * 1024; // 50KB，统计摘要体量很小，设个上限防滥用
const REQUEST_TIMEOUT_MS = 20000;

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "仅支持 POST 请求" }, 405, corsHeaders);
    }

    const apiKey = env.ZHIPU_API_KEY;
    if (!apiKey) {
      return jsonResponse({ ok: false, error: "服务端未配置 ZHIPU_API_KEY" }, 500, corsHeaders);
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: "请求体过大" }, 413, corsHeaders);
    }

    let payload;
    try {
      const rawBody = await request.text();
      if (rawBody.length > MAX_BODY_BYTES) {
        return jsonResponse({ ok: false, error: "请求体过大" }, 413, corsHeaders);
      }
      payload = JSON.parse(rawBody);
    } catch (e) {
      return jsonResponse({ ok: false, error: "请求体不是合法 JSON" }, 400, corsHeaders);
    }

    const stats = payload && payload.stats;
    if (!stats || typeof stats !== "object") {
      return jsonResponse({ ok: false, error: "缺少 stats 字段（统计摘要）" }, 400, corsHeaders);
    }

    // instruction：用户额外要求（生成前设定调性 / 生成后下达修改）
    // currentReport：已有的报告正文（仅"对话改写"时传入），让 AI 基于它做修订
    const instruction = (payload && typeof payload.instruction === "string") ? payload.instruction : "";
    const currentReport = (payload && typeof payload.currentReport === "string") ? payload.currentReport : "";

    const prompt = buildPrompt(stats, instruction, currentReport);

    try {
      const narrative = await callZhipu(apiKey, prompt);
      return jsonResponse({ ok: true, narrative }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse(
        { ok: false, error: "AI 服务调用失败：" + (err && err.message ? err.message : String(err)) },
        502,
        corsHeaders
      );
    }
  },
};

function buildPrompt(stats, instruction, currentReport) {
  const statsJson = JSON.stringify(stats, null, 2);

  // 场景二：已有报告 + 修改指令 -> 修订模式
  if (currentReport && instruction) {
    return (
      "你是一名资深数据分析师。下面是已生成的数据分析报告正文，以及用户希望做的修改指令。" +
      "请基于原始统计数据和用户的修改指令，输出修订后的完整报告正文。" +
      "要求：保持「数据总览」「趋势分析」「维度分析」「结论与建议」四节结构（章节标题用这四个之一），每节 2-4 句；" +
      "只基于已有信息和统计数据，不要编造数字；直接输出正文，不要输出多余说明或问候语。\n\n" +
      "【已有报告正文】\n" + currentReport + "\n\n" +
      "【用户的修改指令】\n" + instruction + "\n\n" +
      "【原始统计数据（JSON，供核对）】\n" + statsJson
    );
  }

  // 场景一：首次生成（可带额外要求）
  let base =
    "你是一名资深数据分析师。请基于以下真实统计结果撰写专业、简洁的中文数据分析报告正文。" +
    "要求：只基于给出的数字做分析，不要编造任何数据或数字；" +
    "分段输出「数据总览」「趋势分析」「维度分析」「结论与建议」四个小节（章节标题用这四个之一），每节 2-4 句话；" +
    "直接输出正文内容，不要输出多余的说明或开头问候语。\n\n" +
    "统计结果（JSON）：\n" + statsJson;
  if (instruction) {
    base += "\n\n【用户额外要求】\n" + instruction;
  }
  return base;
}

async function callZhipu(apiKey, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(ZHIPU_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });

    const data = await resp.text();

    if (!resp.ok) {
      throw new Error(`智谱接口返回状态码 ${resp.status}：${data.slice(0, 300)}`);
    }

    const json = JSON.parse(data);
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) {
      throw new Error("智谱接口返回结构异常，未找到 content");
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
