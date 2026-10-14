/**
 * 腾讯云函数 SCF —— 智谱 GLM-4-Flash 分析文案生成中转层
 *
 * 作用：
 *   前端把"统计分析结果"（纯数字结构，不含敏感信息）POST 到这个云函数，
 *   云函数带着环境变量里的智谱 API Key 去调 GLM-4-Flash，让 AI 把数字组织成
 *   自然语言分析文案，再把文案返回给前端。
 *
 * 安全要点：
 *   - API Key 只存在于云函数环境变量 ZHIPU_API_KEY，不会出现在任何前端代码里
 *   - 函数本身不碰用户上传的原始 Excel 数据，只处理前端已经算好的统计摘要
 *   - 对输入做基本校验，避免被滥用塞入超大 payload
 *
 * 触发方式：API 网关触发器（HTTP 触发），method: ANY，集成响应：是
 *
 * 环境变量：
 *   ZHIPU_API_KEY   —— 智谱 AI 的 API Key（必填）
 *   ALLOWED_ORIGIN  —— 允许跨域访问的来源，比如 https://health-cabin.cn（必填，用于 CORS）
 */

"use strict";

const https = require("https");

const ZHIPU_ENDPOINT = "open.bigmodel.cn";
const ZHIPU_PATH = "/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";
const MAX_BODY_BYTES = 50 * 1024; // 50KB，统计摘要体量很小，设个上限防滥用

exports.main_handler = async (event, context) => {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };

  // 预检请求直接放行
  const method = (event.httpMethod || event.method || "").toUpperCase();
  if (method === "OPTIONS") {
    return { isBase64Encoded: false, statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (method !== "POST") {
    return respond(405, { ok: false, error: "仅支持 POST 请求" }, corsHeaders);
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    return respond(500, { ok: false, error: "服务端未配置 ZHIPU_API_KEY" }, corsHeaders);
  }

  let rawBody = event.body || "";
  if (event.isBase64Encoded) {
    try {
      rawBody = Buffer.from(rawBody, "base64").toString("utf-8");
    } catch (e) {
      return respond(400, { ok: false, error: "请求体 base64 解码失败" }, corsHeaders);
    }
  }

  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return respond(413, { ok: false, error: "请求体过大" }, corsHeaders);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return respond(400, { ok: false, error: "请求体不是合法 JSON" }, corsHeaders);
  }

  const stats = payload && payload.stats;
  if (!stats || typeof stats !== "object") {
    return respond(400, { ok: false, error: "缺少 stats 字段（统计摘要）" }, corsHeaders);
  }

  // instruction：用户额外要求（生成前设定调性 / 生成后下达修改）
  // currentReport：已有的报告正文（仅"对话改写"时传入），让 AI 基于它做修订
  const instruction = (payload && typeof payload.instruction === "string") ? payload.instruction : "";
  const currentReport = (payload && typeof payload.currentReport === "string") ? payload.currentReport : "";

  const prompt = buildPrompt(stats, instruction, currentReport);

  try {
    const aiText = await callZhipu(apiKey, prompt);
    return respond(200, { ok: true, narrative: aiText }, corsHeaders);
  } catch (err) {
    // AI 调用失败时明确返回失败状态，前端据此回退到规则文案，不中断报告生成
    return respond(502, { ok: false, error: "AI 服务调用失败：" + (err && err.message ? err.message : String(err)) }, corsHeaders);
  }
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
    "你是一名数据分析师，请基于以下真实统计结果撰写一段专业、简洁的中文数据分析报告正文。" +
    "要求：只基于给出的数字做分析和推断，不要编造任何数据或数字；语言专业但不生硬；" +
    "分段输出「数据总览」「趋势分析」「维度分析」「结论与建议」四个小节，每节 2-4 句话；" +
    "直接输出正文内容，不要输出多余的说明或开头问候语。\n\n" +
    "统计结果（JSON）：\n" +
    statsJson;
  if (instruction) {
    base += "\n\n【用户额外要求】\n" + instruction;
  }
  return base;
}

function callZhipu(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_tokens: 1200,
    });

    const req = https.request(
      {
        hostname: ZHIPU_ENDPOINT,
        path: ZHIPU_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 20000, // 20秒超时，避免云函数长时间挂起
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`智谱接口返回状态码 ${res.statusCode}：${data.slice(0, 300)}`));
            return;
          }
          try {
            const json = JSON.parse(data);
            const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
            if (!content) {
              reject(new Error("智谱接口返回结构异常，未找到 content"));
              return;
            }
            resolve(content.trim());
          } catch (e) {
            reject(new Error("解析智谱接口返回 JSON 失败：" + e.message));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("请求智谱接口超时（20秒）"));
    });
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function respond(statusCode, obj, headers) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers,
    body: JSON.stringify(obj),
  };
}
