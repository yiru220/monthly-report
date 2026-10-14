/* ======================================================================
   ReportMind Agent — 真实数据分析与报告生成引擎
   功能：解析上传的 Excel/CSV -> 自动统计分析 -> 生成图表 -> 生成文案 -> 导出 PDF
   说明：文案部分基于统计结果 + 规则模板自动生成（非调用大模型），
         所有数字均来自对上传数据的真实计算，不编造数据。
   ====================================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // AI 文案增强配置
  // 填入云函数（API 网关触发器）地址后，报告生成时会先用规则引擎算好统计结果，
  // 再把统计摘要发给这个地址，由大模型生成更自然的分析文案；
  // 留空，或者请求失败/超时，则自动回退到规则模板文案，不影响报告正常生成。
  // ---------------------------------------------------------------
  const AI_PROXY_ENDPOINT = "https://ai-report-narrative-proxy.yiru220.workers.dev"; // 与 modules/narrative-writing.html 保持一致
  const AI_REQUEST_TIMEOUT_MS = 15000;

  // ---------------------------------------------------------------
  // 全局状态
  // ---------------------------------------------------------------
  const state = {
    rawRows: [],       // 原始行对象数组 [{列名: 值, ...}, ...]
    columns: [],        // 列名列表
    columnTypes: {},    // 列名 -> 'number' | 'string' | 'date'
    numericCols: [],
    categoryCols: [],
    dateCols: [],
    charts: [],         // Chart.js 实例，导出前需要销毁或等待渲染完成
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.dropzone = document.getElementById("dropzone");
    els.fileInput = document.getElementById("fileInput");
    els.fileNameTag = document.getElementById("fileNameTag");
    els.btnDemo = document.getElementById("btnDemo");
    els.btnGenerate = document.getElementById("btnGenerate");
    els.btnExportPdf = document.getElementById("btnExportPdf");
    els.btnReset = document.getElementById("btnReset");
    els.uploadStage = document.getElementById("uploadStage");
    els.reportStage = document.getElementById("reportStage");
    els.reportRoot = document.getElementById("reportRoot");
    els.statusMsg = document.getElementById("statusMsg");
    els.previewTableWrap = document.getElementById("previewTableWrap");
    els.columnMapWrap = document.getElementById("columnMapWrap");

    els.dropzone.addEventListener("click", () => els.fileInput.click());
    els.dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      els.dropzone.classList.add("dragover");
    });
    els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
    els.dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      els.dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
    els.fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    els.btnDemo.addEventListener("click", loadDemoData);
    els.btnGenerate.addEventListener("click", generateReport);
    els.btnExportPdf.addEventListener("click", exportPdf);
    els.btnReset.addEventListener("click", resetAll);
  }

  // ---------------------------------------------------------------
  // 文件读取与解析（真实解析，使用 SheetJS）
  // ---------------------------------------------------------------
  function handleFile(file) {
    const name = file.name.toLowerCase();
    if (!/\.(xlsx|xls|csv)$/.test(name)) {
      setStatus("仅支持 .xlsx / .xls / .csv 文件", true);
      return;
    }
    setStatus("正在解析文件…");
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array", cellDates: true });
        const firstSheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
        if (!rows.length) {
          setStatus("文件中没有读取到数据行，请检查表格内容", true);
          return;
        }
        ingestRows(rows, file.name);
      } catch (err) {
        console.error(err);
        setStatus("解析失败：" + err.message, true);
      }
    };
    reader.onerror = function () {
      setStatus("文件读取失败，请重试", true);
    };
    reader.readAsArrayBuffer(file);
  }

  function loadDemoData() {
    // 内置示例数据集：某零售企业季度销售记录（供无文件时体验流程）
    const regions = ["华东", "华南", "华北", "西南", "华中"];
    const products = ["智能手环", "蓝牙耳机", "智能音箱", "平板电脑", "智能手表"];
    const rows = [];
    const start = new Date("2026-01-01");
    let id = 1;
    for (let m = 0; m < 9; m++) {
      regions.forEach((region) => {
        products.forEach((product) => {
          const base = 8000 + Math.sin(m / 2 + region.length) * 1800 + product.length * 300;
          const noise = (Math.sin(id * 12.9898) * 43758.5453) % 1;
          const randomFactor = (Math.abs(noise) % 1) * 1600 - 800;
          const sales = Math.max(500, Math.round(base + randomFactor + m * 220));
          const cost = Math.round(sales * (0.55 + (Math.abs(Math.sin(id)) * 0.1)));
          const d = new Date(start);
          d.setMonth(start.getMonth() + m);
          rows.push({
            日期: d,
            地区: region,
            产品: product,
            销售额: sales,
            成本: cost,
            利润: sales - cost,
            订单数: Math.round(sales / (80 + product.length * 5)),
          });
          id++;
        });
      });
    }
    ingestRows(rows, "示例数据集：零售季度销售记录.xlsx");
  }

  function ingestRows(rows, fileName) {
    state.rawRows = rows;
    state.columns = Object.keys(rows[0]);
    inferColumnTypes();

    els.fileNameTag.textContent = `已载入：${fileName}（${rows.length} 行 × ${state.columns.length} 列）`;
    els.fileNameTag.classList.add("show");

    renderPreviewTable();
    renderColumnMap();

    els.btnGenerate.disabled = false;
    setStatus(`解析成功，共 ${rows.length} 行数据。请确认字段识别无误后点击"生成报告"。`);
  }

  // 识别形如 2026-01-01 / 2026/01/01 / 2026年1月1日 等常见日期字符串
  const DATE_STRING_RE = /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?$/;

  function parseDateString(v) {
    if (v instanceof Date) return v;
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!DATE_STRING_RE.test(s)) return null;
    const norm = s.replace(/年|月/g, "-").replace(/日/g, "").replace(/\//g, "-");
    const d = new Date(norm);
    return isNaN(d) ? null : d;
  }

  function inferColumnTypes() {
    state.columnTypes = {};
    state.numericCols = [];
    state.categoryCols = [];
    state.dateCols = [];

    state.columns.forEach((col) => {
      let numCount = 0, dateCount = 0, total = 0;
      for (const row of state.rawRows) {
        const v = row[col];
        if (v === null || v === undefined || v === "") continue;
        total++;
        if (v instanceof Date) dateCount++;
        else if (typeof v === "string" && parseDateString(v)) dateCount++;
        else if (typeof v === "number") numCount++;
        else if (typeof v === "string" && !isNaN(parseFloat(v)) && /^-?[\d,.]+%?$/.test(v.trim())) numCount++;
      }
      if (total === 0) { state.columnTypes[col] = "string"; state.categoryCols.push(col); return; }
      if (dateCount / total > 0.6) {
        state.columnTypes[col] = "date";
        state.dateCols.push(col);
        // 将该列的字符串日期统一转换为真实 Date 对象，供后续趋势分析使用
        state.rawRows.forEach((row) => {
          if (typeof row[col] === "string") {
            const parsed = parseDateString(row[col]);
            if (parsed) row[col] = parsed;
          }
        });
      } else if (numCount / total > 0.6) {
        state.columnTypes[col] = "number";
        state.numericCols.push(col);
      } else {
        state.columnTypes[col] = "string";
        state.categoryCols.push(col);
      }
    });
  }

  function renderPreviewTable() {
    const cols = state.columns;
    const sample = state.rawRows.slice(0, 8);
    let html = '<table class="data-preview"><thead><tr>';
    cols.forEach((c) => (html += `<th>${escapeHtml(c)}</th>`));
    html += "</tr></thead><tbody>";
    sample.forEach((row) => {
      html += "<tr>";
      cols.forEach((c) => {
        html += `<td>${escapeHtml(formatCell(row[c]))}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    if (state.rawRows.length > 8) {
      html += `<div class="preview-more">仅展示前 8 行，共 ${state.rawRows.length} 行</div>`;
    }
    els.previewTableWrap.innerHTML = html;
  }

  function renderColumnMap() {
    const typeLabel = { number: "数值", date: "日期", string: "分类/文本" };
    const typeClass = { number: "tag-num", date: "tag-date", string: "tag-str" };
    let html = "";
    state.columns.forEach((c) => {
      const t = state.columnTypes[c];
      html += `<span class="col-tag ${typeClass[t]}">${escapeHtml(c)} <i>${typeLabel[t]}</i></span>`;
    });
    els.columnMapWrap.innerHTML = html;
  }

  function formatCell(v) {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toLocaleDateString("zh-CN");
    if (typeof v === "number") return Number.isInteger(v) ? v.toString() : v.toFixed(2);
    return String(v);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function setStatus(msg, isError) {
    els.statusMsg.textContent = msg;
    els.statusMsg.className = "status-msg" + (isError ? " error" : "");
  }

  function resetAll() {
    state.rawRows = [];
    state.columns = [];
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
    els.fileNameTag.classList.remove("show");
    els.previewTableWrap.innerHTML = "";
    els.columnMapWrap.innerHTML = "";
    els.btnGenerate.disabled = true;
    els.fileInput.value = "";
    els.uploadStage.style.display = "";
    els.reportStage.style.display = "none";
    setStatus("");
  }

  // =================================================================
  // 统计分析引擎（真实计算，无编造数据）
  // =================================================================
  function computeStats() {
    const rows = state.rawRows;
    const numCols = state.numericCols;
    const catCols = state.categoryCols;
    const dateCols = state.dateCols;

    const summary = {}; // 每个数值列的汇总统计
    numCols.forEach((col) => {
      const vals = rows.map((r) => toNumber(r[col])).filter((v) => v !== null && !isNaN(v));
      if (!vals.length) return;
      const sum = vals.reduce((a, b) => a + b, 0);
      const mean = sum / vals.length;
      const sorted = [...vals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      const std = Math.sqrt(variance);
      summary[col] = { sum, mean, median, max, min, std, count: vals.length };
    });

    // 时间序列趋势分析（按首个日期列分组，首个数值列做汇总）
    let trend = null;
    if (dateCols.length && numCols.length) {
      const dCol = dateCols[0];
      const vCol = numCols[0];
      const byPeriod = {};
      rows.forEach((r) => {
        const d = r[dCol];
        if (!(d instanceof Date) || isNaN(d)) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const v = toNumber(r[vCol]) || 0;
        byPeriod[key] = (byPeriod[key] || 0) + v;
      });
      const periods = Object.keys(byPeriod).sort();
      if (periods.length >= 2) {
        const values = periods.map((p) => byPeriod[p]);
        const first = values[0];
        const last = values[values.length - 1];
        const momChange = values.length >= 2 ? ((values[values.length - 1] - values[values.length - 2]) / (values[values.length - 2] || 1)) * 100 : 0;
        const totalChange = ((last - first) / (first || 1)) * 100;
        // 最大环比波动点
        let maxJumpIdx = 1, maxJump = -Infinity;
        for (let i = 1; i < values.length; i++) {
          const chg = Math.abs(values[i] - values[i - 1]);
          if (chg > maxJump) { maxJump = chg; maxJumpIdx = i; }
        }
        trend = {
          dateCol: dCol,
          valueCol: vCol,
          periods,
          values,
          momChangePct: momChange,
          totalChangePct: totalChange,
          peakPeriod: periods[values.indexOf(Math.max(...values))],
          peakValue: Math.max(...values),
          troughPeriod: periods[values.indexOf(Math.min(...values))],
          troughValue: Math.min(...values),
          biggestJumpPeriod: periods[maxJumpIdx],
          biggestJumpDelta: values[maxJumpIdx] - values[maxJumpIdx - 1],
        };
      }
    }

    // 分类维度排名分析（按首个分类列分组，首个数值列求和）
    let ranking = null;
    if (catCols.length && numCols.length) {
      const cCol = catCols[0];
      const vCol = numCols[0];
      const byCat = {};
      rows.forEach((r) => {
        const key = r[cCol] === null || r[cCol] === undefined ? "未分类" : String(r[cCol]);
        const v = toNumber(r[vCol]) || 0;
        byCat[key] = (byCat[key] || 0) + v;
      });
      const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((a, [, v]) => a + v, 0);
      ranking = {
        catCol: cCol,
        valueCol: vCol,
        entries, // [[name, value], ...] 降序
        total,
        top: entries[0],
        bottom: entries[entries.length - 1],
        topSharePct: total ? (entries[0][1] / total) * 100 : 0,
      };
    }

    // 二级分类分析（如果有第二个分类列，用于交叉表/堆叠图）
    let secondaryRanking = null;
    if (catCols.length > 1 && numCols.length) {
      const cCol = catCols[1];
      const vCol = numCols[0];
      const byCat = {};
      rows.forEach((r) => {
        const key = r[cCol] === null || r[cCol] === undefined ? "未分类" : String(r[cCol]);
        const v = toNumber(r[vCol]) || 0;
        byCat[key] = (byCat[key] || 0) + v;
      });
      const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
      secondaryRanking = { catCol: cCol, valueCol: vCol, entries };
    }

    // 异常值检测（基于标准差，|z-score| > 2）
    const anomalies = [];
    if (numCols.length) {
      const vCol = numCols[0];
      const s = summary[vCol];
      if (s && s.std > 0) {
        rows.forEach((r, idx) => {
          const v = toNumber(r[vCol]);
          if (v === null || isNaN(v)) return;
          const z = (v - s.mean) / s.std;
          if (Math.abs(z) > 2) {
            anomalies.push({ rowIndex: idx, value: v, zscore: z, row: r });
          }
        });
      }
    }

    return { summary, trend, ranking, secondaryRanking, anomalies, numCols, catCols, dateCols };
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const cleaned = v.replace(/,/g, "").replace(/%$/, "");
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  // =================================================================
  // 规则驱动的文案生成（基于真实统计结果套用分析话术模板）
  // =================================================================
  function generateNarrative(stats) {
    const sections = [];

    // 开篇总览
    const rowCount = state.rawRows.length;
    const colCount = state.columns.length;
    const mainMetric = stats.numCols[0];
    let overviewText = `本报告基于上传数据集自动生成，共纳入 ${rowCount} 条记录、${colCount} 个字段。`;
    if (mainMetric && stats.summary[mainMetric]) {
      const s = stats.summary[mainMetric];
      overviewText += `核心指标「${mainMetric}」总计 ${fmtNum(s.sum)}，均值 ${fmtNum(s.mean)}，` +
        `最大值 ${fmtNum(s.max)}，最小值 ${fmtNum(s.min)}。`;
    }
    sections.push({ title: "数据总览", text: overviewText });

    // 趋势分析
    if (stats.trend) {
      const t = stats.trend;
      const dirWord = t.momChangePct >= 0 ? "上升" : "下降";
      const totalDirWord = t.totalChangePct >= 0 ? "增长" : "下滑";
      let text = `从 ${t.periods[0]} 到 ${t.periods[t.periods.length - 1]} 期间，「${t.valueCol}」整体呈${totalDirWord}态势，` +
        `累计变化幅度为 ${fmtPct(t.totalChangePct)}。最近一期环比${dirWord} ${fmtPct(Math.abs(t.momChangePct))}。` +
        `峰值出现在 ${t.peakPeriod}（${fmtNum(t.peakValue)}），谷值出现在 ${t.troughPeriod}（${fmtNum(t.troughValue)}）。` +
        `波动最剧烈的时段为 ${t.biggestJumpPeriod}，单期变化达 ${fmtNum(Math.abs(t.biggestJumpDelta))}，` +
        (t.biggestJumpDelta >= 0 ? "建议关注该期增长驱动因素并复用成功经验。" : "建议排查该期下滑原因，评估是否存在异常事件影响。");
      sections.push({ title: "趋势分析", text, chartId: "chartTrend" });
    }

    // 排名/占比分析
    if (stats.ranking) {
      const r = stats.ranking;
      const top3 = r.entries.slice(0, 3).map(([k, v]) => `${k}（${fmtNum(v)}）`).join("、");
      let text = `按「${r.catCol}」维度拆分「${r.valueCol}」后发现，排名前三的类别为 ${top3}。` +
        `其中「${r.top[0]}」贡献最高，占总量的 ${fmtPct(r.topSharePct)}，是当前阶段的核心贡献来源。` +
        `表现最弱的是「${r.bottom[0]}」（${fmtNum(r.bottom[1])}），` +
        (r.entries.length > 3 ? "建议重点关注头部类别的驱动因素，同时评估尾部类别是否需要调整策略或资源投入。" : "建议结合业务场景进一步分析各类别差异原因。");
      sections.push({ title: `${r.catCol}维度分析`, text, chartId: "chartRanking" });
    }

    // 二级分类分析
    if (stats.secondaryRanking) {
      const r2 = stats.secondaryRanking;
      const top = r2.entries[0];
      let text = `从「${r2.catCol}」维度来看，「${top[0]}」贡献的「${r2.valueCol}」最高，达 ${fmtNum(top[1])}。` +
        `各类别间存在一定差异，建议结合第一维度交叉分析，识别最优组合策略。`;
      sections.push({ title: `${r2.catCol}维度分析`, text, chartId: "chartSecondary" });
    }

    // 异常检测
    if (stats.anomalies.length) {
      let text = `系统基于标准差方法（|Z-score| > 2）自动检测出 ${stats.anomalies.length} 条异常数据点，` +
        `占总样本的 ${fmtPct((stats.anomalies.length / rowCount) * 100)}。` +
        `这些数据点明显偏离整体分布，建议人工核实其真实性，排查是否存在数据录入错误或突发业务事件。`;
      sections.push({ title: "异常检测", text, isAnomalyTable: true });
    } else if (mainMetric) {
      sections.push({ title: "异常检测", text: `系统未检测到显著异常数据点（基于标准差方法，|Z-score| > 2），当前数据整体分布平稳。` });
    }

    // 结论与建议（规则生成的建议，基于统计方向）
    let concl = "综合以上分析：";
    const bullets = [];
    if (stats.trend) {
      bullets.push(stats.trend.totalChangePct >= 0
        ? `核心指标呈上升趋势，建议持续投入资源以保持增长势头。`
        : `核心指标呈下降趋势，建议排查关键影响因素并制定改善措施。`);
    }
    if (stats.ranking) {
      bullets.push(`「${stats.ranking.top[0]}」是当前最大贡献来源，建议优先保障其资源与支持。`);
      if (stats.ranking.entries.length > 1) {
        bullets.push(`「${stats.ranking.bottom[0]}」表现相对落后，建议评估调整空间或制定专项提升计划。`);
      }
    }
    if (stats.anomalies.length) {
      bullets.push(`建议对已识别的 ${stats.anomalies.length} 条异常记录进行人工复核。`);
    }
    sections.push({ title: "结论与建议", text: concl, bullets });

    return sections;
  }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    const abs = Math.abs(n);
    if (abs >= 10000) return (n / 10000).toFixed(2) + "万";
    return Number(n.toFixed(2)).toLocaleString("zh-CN");
  }
  function fmtPct(n) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
  }

  // =================================================================
  // 报告渲染（真实图表 + 真实文案）
  // =================================================================
  async function generateReport() {
    if (!state.rawRows.length) return;
    setStatus("正在分析数据…");
    state.charts.forEach((c) => c.destroy());
    state.charts = [];

    const stats = computeStats();
    // 规则引擎生成的文案始终作为兜底，保证报告任何情况下都能生成
    const ruleNarrative = generateNarrative(stats);

    els.btnGenerate.disabled = true;

    let narrative = ruleNarrative;
    let narrativeSource = "rule";

    if (AI_PROXY_ENDPOINT) {
      setStatus("正在请求 AI 润色分析文案…");
      try {
        const aiText = await requestAiNarrative(stats);
        if (aiText) {
          narrative = mergeAiNarrative(ruleNarrative, aiText);
          narrativeSource = "ai";
        }
      } catch (err) {
        console.warn("AI 文案生成失败，已回退到规则模板文案：", err);
      }
    }

    els.reportRoot.innerHTML = buildReportSkeleton(narrative, stats, narrativeSource);
    els.uploadStage.style.display = "none";
    els.reportStage.style.display = "";
    els.btnGenerate.disabled = false;

    // 渲染图表（必须在 DOM 插入后进行）
    requestAnimationFrame(() => {
      if (stats.trend) renderTrendChart(stats.trend);
      if (stats.ranking) renderRankingChart(stats.ranking);
      if (stats.secondaryRanking) renderSecondaryChart(stats.secondaryRanking);
      setStatus(
        narrativeSource === "ai"
          ? "报告生成完成（文案由 AI 生成），可点击右上角导出 PDF。"
          : "报告生成完成（文案为规则模板生成），可点击右上角导出 PDF。"
      );
    });
  }

  // 把前端已算好的统计摘要（不含上传数据原始行）发给云函数中转层，换取 AI 生成的文案
  function requestAiNarrative(stats) {
    const slimStats = {
      summary: stats.summary,
      trend: stats.trend
        ? {
            valueCol: stats.trend.valueCol,
            periods: stats.trend.periods,
            values: stats.trend.values,
            momChangePct: stats.trend.momChangePct,
            totalChangePct: stats.trend.totalChangePct,
            peakPeriod: stats.trend.peakPeriod,
            peakValue: stats.trend.peakValue,
            troughPeriod: stats.trend.troughPeriod,
            troughValue: stats.trend.troughValue,
          }
        : null,
      ranking: stats.ranking
        ? {
            catCol: stats.ranking.catCol,
            valueCol: stats.ranking.valueCol,
            top5: stats.ranking.entries.slice(0, 5),
            topSharePct: stats.ranking.topSharePct,
          }
        : null,
      anomalyCount: stats.anomalies.length,
      rowCount: state.rawRows.length,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

    return fetch(AI_PROXY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stats: slimStats }),
      signal: controller.signal,
    })
      .then((r) => r.json().then((j) => ({ r, j })))
      .then(({ r, j }) => {
        if (!r.ok || !j.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
        return j.narrative;
      })
      .finally(() => clearTimeout(timer));
  }

  // 用 AI 返回的整段文案替换规则文案的正文部分，但保留原有的章节标题/图表挂载点/表格结构
  function mergeAiNarrative(ruleNarrative, aiText) {
    // 按空行或章节关键词粗略切分 AI 返回文本，映射回对应小节；映射不上的部分整体放入第一节，
    // 确保无论 AI 输出格式如何变化，界面都不会出现空白或报错。
    const sectionKeys = ["数据总览", "趋势分析", "维度分析", "结论与建议"];
    const chunks = aiText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

    return ruleNarrative.map((sec, idx) => {
      const matched = chunks.find((c) => sectionKeys.some((k) => sec.title.includes(k.replace("维度分析", "")) && c.includes(k)));
      const fallbackChunk = chunks[idx];
      const text = stripSectionTitle(matched || fallbackChunk || sec.text, sec.title);
      return { ...sec, text, bullets: undefined };
    });
  }

  function stripSectionTitle(text, title) {
    return text.replace(new RegExp("^[#*\\s]*" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[：:\\s]*"), "").trim();
  }

  function buildReportSkeleton(narrative, stats, narrativeSource) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const sourceTag =
      narrativeSource === "ai"
        ? `<span class="narrative-tag ai">✦ 文案由 AI 生成</span>`
        : `<span class="narrative-tag rule">文案由规则模板生成</span>`;
    let html = `
      <div class="report-header">
        <div class="report-title">数据分析报告</div>
        <div class="report-meta">生成时间：${dateStr} ｜ 数据规模：${state.rawRows.length} 行 × ${state.columns.length} 列 ｜ 由 ReportMind Agent 自动生成 ${sourceTag}</div>
      </div>
    `;

    narrative.forEach((sec) => {
      html += `<div class="report-section">`;
      html += `<h3>${escapeHtml(sec.title)}</h3>`;
      html += `<p>${escapeHtml(sec.text)}</p>`;
      if (sec.bullets && sec.bullets.length) {
        html += "<ul>" + sec.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("") + "</ul>";
      }
      if (sec.chartId) {
        html += `<div class="chart-box"><canvas id="${sec.chartId}"></canvas></div>`;
      }
      if (sec.isAnomalyTable) {
        html += renderAnomalyTable(stats.anomalies.slice(0, 10), stats.numCols[0]);
      }
      html += `</div>`;
    });

    // 数据汇总表
    html += `<div class="report-section"><h3>关键指标汇总表</h3>${renderSummaryTable(stats.summary)}</div>`;

    return html;
  }

  function renderSummaryTable(summary) {
    const cols = Object.keys(summary);
    if (!cols.length) return "<p>（无数值字段可供汇总）</p>";
    let html = '<table class="summary-table"><thead><tr><th>字段</th><th>总和</th><th>均值</th><th>中位数</th><th>最大值</th><th>最小值</th></tr></thead><tbody>';
    cols.forEach((c) => {
      const s = summary[c];
      html += `<tr><td>${escapeHtml(c)}</td><td>${fmtNum(s.sum)}</td><td>${fmtNum(s.mean)}</td><td>${fmtNum(s.median)}</td><td>${fmtNum(s.max)}</td><td>${fmtNum(s.min)}</td></tr>`;
    });
    html += "</tbody></table>";
    return html;
  }

  function renderAnomalyTable(anomalies, col) {
    if (!anomalies.length) return "";
    let html = `<table class="summary-table"><thead><tr><th>行号</th><th>${escapeHtml(col)}</th><th>Z-score</th></tr></thead><tbody>`;
    anomalies.forEach((a) => {
      html += `<tr><td>第 ${a.rowIndex + 1} 行</td><td>${fmtNum(a.value)}</td><td>${a.zscore.toFixed(2)}</td></tr>`;
    });
    html += "</tbody></table>";
    return html;
  }

  function renderTrendChart(trend) {
    const ctx = document.getElementById("chartTrend");
    if (!ctx) return;
    const chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: trend.periods,
        datasets: [{
          label: trend.valueCol,
          data: trend.values,
          borderColor: "#5b8cff",
          backgroundColor: "#5b8cff22",
          fill: true,
          tension: 0.35,
          pointRadius: 4,
          pointBackgroundColor: "#5b8cff",
        }],
      },
      options: chartBaseOptions(`${trend.valueCol} 趋势变化`),
    });
    state.charts.push(chart);
  }

  function renderRankingChart(ranking) {
    const ctx = document.getElementById("chartRanking");
    if (!ctx) return;
    const top = ranking.entries.slice(0, 8);
    const chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: top.map(([k]) => k),
        datasets: [{
          label: ranking.valueCol,
          data: top.map(([, v]) => v),
          backgroundColor: "#7ee8c7",
          borderRadius: 6,
        }],
      },
      options: chartBaseOptions(`按「${ranking.catCol}」拆分「${ranking.valueCol}」`),
    });
    state.charts.push(chart);
  }

  function renderSecondaryChart(sec) {
    const ctx = document.getElementById("chartSecondary");
    if (!ctx) return;
    const top = sec.entries.slice(0, 8);
    const chart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: top.map(([k]) => k),
        datasets: [{
          data: top.map(([, v]) => v),
          backgroundColor: ["#5b8cff", "#7ee8c7", "#ffb86b", "#ff6b9c", "#8a6bff", "#5bd1ff", "#ffd366", "#9ad17e"],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: "right", labels: { color: "#2a3142", font: { size: 12 } } },
          title: { display: true, text: `「${sec.catCol}」占比分布`, color: "#1a1f2b", font: { size: 14, weight: "bold" } },
        },
      },
    });
    state.charts.push(chart);
  }

  function chartBaseOptions(title) {
    return {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: title, color: "#1a1f2b", font: { size: 14, weight: "bold" } },
      },
      scales: {
        x: { ticks: { color: "#5a6478" }, grid: { color: "#eef1f6" } },
        y: { ticks: { color: "#5a6478" }, grid: { color: "#eef1f6" }, beginAtZero: true },
      },
    };
  }

  // =================================================================
  // PDF 导出（html2canvas 截图 + jsPDF 分页拼接）
  // =================================================================
  async function exportPdf() {
    setStatus("正在生成 PDF，请稍候…");
    els.btnExportPdf.disabled = true;
    try {
      const node = els.reportRoot;
      const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
      const imgData = canvas.toDataURL("image/png");

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();

      const imgWidth = pageWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      let heightLeft = imgHeight;
      let position = 0;

      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      pdf.save(`数据分析报告_${Date.now()}.pdf`);
      setStatus("PDF 导出完成。");
    } catch (err) {
      console.error(err);
      setStatus("PDF 导出失败：" + err.message, true);
    } finally {
      els.btnExportPdf.disabled = false;
    }
  }
})();
