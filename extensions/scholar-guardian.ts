/**
 * =====================================================================
 * ScholarGuardian —— Pi Extension（第十阶段：检索词智能优化 Query Rewriting）
 * =====================================================================
 *
 * 项目定位：
 *   ScholarGuardian 是一个面向学术写作场景的"引用守护"扩展，用于
 *   对 LLM 生成的检索内容 / 参考文献引用进行真伪核验，防止模型产生
 *   "幻觉引用"（hallucinated citations）。
 *
 * 实现进度：
 *   第一阶段：项目骨架与核心类型定义（RetrievalResult / VerificationResult / 入口骨架）。
 *   第二阶段：动态防御注入 —— 监听 before_agent_start，识别科研意图后
 *                向 System Prompt 末尾追加"引用安全约束"（不覆盖原有 Prompt）。
 *   第三阶段：注册自定义工具 scholar_retrieve（TypeBox Schema + Mock 检索）。
 *   第四阶段：后置校验与反思闭环 —— 监听 message_update，抽取模型输出中的
 *            [Ref_ID] 与检索结果比对，告警并注入纠错触发自我修正。
 *   第五阶段：接入真实科研检索后端 —— scholar_retrieve 调用
 *            Semantic Scholar Graph API；后置校验改用会话级动态引用集。
 *   第六阶段：429 限流指数退避重试（1s→2s→4s + 随机抖动，至多 3 次）
 *            与文献结构化解析（Markdown 排版 RetrievalResult）。
 *   第七阶段：双源热备检索 —— Semantic Scholar（主）失败自动降级
 *            CrossRef（备）；双源均不可用时返回明确错误提示。
 *   第八阶段：三级降级检索 —— 新增 OpenAlex 作为终极摘要防线
 *            （处理 CrossRef 无摘要或主备均失败的情形，含倒排索引还原）。
 *   第九阶段：论文全文解析与深度问答 —— Python(PyMuPDF) 解析本地 PDF，
 *            TS 侧新增 scholar_read_fulltext 工具并强化"全文规范"系统提示。
 *   第十阶段（当前）：检索词智能优化（Query Rewriting）—— 口语/模糊查询在调用
 *            外部 API 之前先规则化重写为学术检索式（实体提取+术语映射+AND 连接）。
 *
 * 存放位置（依据 Pi 官方 Extension 规范）：
 *   本文件位于项目级自动发现目录 .pi/extensions/ 下，
 *   Pi 启动时会自动加载，并支持 /reload 命令热重载。
 *
 * 生命周期：
 *   Extension 被 Pi 加载时调用默认导出的工厂函数（本文件底部），
 *   工厂函数内部通过 pi.on(...) 订阅所需的生命周期事件。
 *
 * 参考资料：
 *   Pi 官方 Extension 规范 —— docs/extensions.md
 *     - 自动发现目录：~/.pi/agent/extensions/（全局）与
 *       .pi/extensions/（项目级，需项目被信任后加载）
 *     - Extension 为 TypeScript 模块，默认导出接收 ExtensionAPI 的工厂函数
 *     - 事件订阅：pi.on("event_name", async (event, ctx) => {...})
 *     - 事件名称为 kebab-case 字符串，如 session_start / session_shutdown
 * =====================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/* =====================================================================
 * 一、核心类型定义
 * ===================================================================== */

/**
 * RetrievalResult —— 检索（Retrieval）结果的数据结构。
 *
 * 用途说明：
 *   在 ScholarGuardian 的流水线中，检索器（Retriever）从外部学术
 *   数据源（如 CrossRef、PubMed、ArXiv 等）拉取文献条目后，会以
 *   本结构作为统一的数据载体返回。后续的引用核验环节将基于该结构
 *   进行比对与判定。
 */
export interface RetrievalResult {
  /**
   * 检索命中的正文内容片段（摘要 / 元数据正文等），用于语义比对。
   */
  content: string;

  /**
   * 该检索结果在数据源中的唯一引用标识
   * （如 DOI、PubMed ID、ArXiv ID 等）。
   */
  ref_id: string;

  /**
   * 附加元数据（键值对形式），用于携带无法被固定字段覆盖的扩展信息，
   * 例如：作者列表、出版年份、期刊名称、检索置信度等。
   */
  metadata: Record<string, any>;
}

/**
 * VerificationResult —— 引用核验（Verification）的结果数据结构。
 *
 * 用途说明：
 *   核验器（Verifier）将 LLM 生成的引用与 RetrievalResult 进行比对后，
 *   返回本结构，用于告知上层：该引用是否真实有效；若无效，则应向
 *   LLM / 用户反馈何种纠错信息。
 */
export interface VerificationResult {
  /**
   * 核验是否通过：
   *   - true  ：引用真实存在且与检索结果吻合；
   *   - false ：引用为幻觉（不存在 / 不吻合 / 关键信息错误）。
   */
  is_valid: boolean;

  /**
   * 当 is_valid 为 false 时，向调用方（LLM / 用户）提供的纠错反馈文案，
   * 例如："未找到 ref_id=xxx 对应的文献，请检查 DOI 是否正确。"。
   * 核验通过时该字段为 null。
   */
  error_feedback: string | null;
}

/* =====================================================================
 * 二、动态防御注入（第二阶段）
 * ===================================================================== */

/**
 * 科研意图触发关键词表。
 *
 * 设计说明：本阶段采用"轻量级关键词匹配"实现意图识别 —— 不调用模型、
 * 不产生额外 API 开销，仅对用户输入做子串包含判断，成本几乎为零。
 *
 * 命中规则：输入（转为小写后）包含词表中任意一个词条，即判定为科研意图。
 * 词表同时收录中英文常用学术术语，可按需增补（学科词、期刊名等）。
 */
const RESEARCH_KEYWORDS: readonly string[] = [
  "论文",
  "文献",
  "引用",
  "研究",
  "学术",
  "期刊",
  "综述",
  "参考文献",
  "citation",
  "reference",
  "paper",
  "literature",
  "research",
];

/**
 * 防御性注入指令：以独立段落追加到 System Prompt 末尾。
 *
 * 目的：在科研写作场景下从"系统提示层"约束 LLM —— 必须基于给定上下文、
 * 必须携带 [Ref_ID] 引用、上下文缺失时必须明示"无法确定"而非编造，
 * 从而在源头抑制"幻觉引用 / 编造文献"。
 */
const SCHOLAR_GUARDIAN_DEFENSE_PROMPT = `【ScholarGuardian 安全约束】：
1. 你的回答必须严格基于提供的上下文。
2. 每一个事实陈述句后，必须紧跟 [Ref_ID] 格式的引用。
3. 如果上下文中没有答案，必须明确回答"根据现有文献无法确定"，严禁编造。

【全文解析规范】：当用户询问论文的具体实验细节、公式或数据集时，你必须先调用 \`scholar_read_fulltext\` 获取全文。严禁基于标题或摘要去猜测论文内部细节！如果 PDF 下载或解析失败，必须明确告知用户无法获取全文，禁止编造实验细节。\n\n【向量检索规范】：你获取到的全文片段是经过语义相似度匹配的最相关段落。请严格基于这些片段回答微观细节问题。如果片段中不包含答案，必须明确告知用户，严禁跨片段拼接或编造。\n\n【工具路由规范】：请根据用户意图选择最合适的工具——当用户询问“最新研究动态/新闻/近期进展”等时间敏感问题时使用 web_search；当用户要求“写脚本/处理数据/执行代码”时使用 code_interpreter；仅当询问具体论文细节或需要文献支撑的学术问题时，才使用 scholar_retrieve 与 scholar_read_fulltext。`;

/**
 * 轻量级科研意图识别。
 *
 * @param prompt 用户本轮输入原文（来自 before_agent_start 事件的 event.prompt）
 * @returns true = 科研意图；false = 非科研意图
 */
function isResearchIntent(prompt: string): boolean {
  // 统一转小写后匹配，兼顾英文关键词的大小写变体（如 Paper / PAPER）。
  const normalized = prompt.toLowerCase();
  return RESEARCH_KEYWORDS.some((kw) => normalized.includes(kw.toLowerCase()));
}

/* =====================================================================
 * 三、自定义工具：scholar_retrieve（第三阶段）
 * ===================================================================== */

/**
 * scholar_retrieve 的参数 Schema（TypeBox）。
 *
 * 规范说明：Pi 的工具入参使用 TypeBox 定义 JSON Schema，
 * LLM 会根据该 Schema 自动生成合法入参；query 为必填 string。
 */
const scholarRetrieveParams = Type.Object({
  query: Type.String({
    description: "检索查询词：用户想查找 / 核验的学术主题、标题片段或关键词",
  }),
  user_role: Type.Union([Type.Literal("student"), Type.Literal("admin")], {
    description: "当前用户角色（RBAC 权限控制）：student 或 admin",
  }),
});

/**
 * 查询重写（Query Rewriting）—— scholar_retrieve 的前置优化步骤。
 *
 * 【为什么需要它：提升 RAG 召回率（Recall）的关键作用】
 *   召回率取决于“检索式”与文献库索引的匹配程度。用户自然语言查询往往口语化、
 *   模糊且中英混杂（如 “AlphaFold 3 怎么预测配体”），若原样送给 API：
 *     - 口语词在学术索引中无匹配，命中率低；
 *     - 填充词/语气词稀释关键词密度，削弱相关性排序；
 *     - 隐含核心概念（如 protein-ligand complex）不会自动补全。
 *   查询重写发生在“任何外部 API 调用之前”，把口语查询规整为
 *   “核心实体 + 学术术语”并用 AND 连接的检索式 —— 把用户意图翻译成
 *   文献库听得懂的语言，直接改善 top-k 召回质量。
 *
 * 实现选型：轻量规则引擎（正则提取 + 术语映射），不依赖二次大模型调用，
 * 零额外延迟与成本；规则可随领域词表持续扩充。
 */
function rewriteQuery(rawQuery: string): string {
  // ── 0) 清洗：去首尾空白、压缩空白，剔除口语填充词/语气词 ────────
  let cleaned = rawQuery.trim().replace(/\s+/g, " ");
  cleaned = cleaned.replace(
    /^(?:请|帮我|帮|麻烦|请您|您好|你好|我想(?:了解|知道|查询|找)|介绍一下|介绍|简述|总结|聊聊|说说|推荐|告诉我|给(?:我|你)|查一下|找一下|关于)[\s:，,、]*/,
    "",
  );
  cleaned = cleaned
    .replace(/(?:怎么|如何|怎样|咋|能否|能不能|是否)[\s的]?/g, "")
    .replace(/[一下吗呢吧的了啊哦呀]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = cleaned.toLowerCase();

  // ── 1) 核心实体 / 学术术语抽取表（按优先级排列：长短语在前，避免子串抢先）──
  const TERM_RULES: Array<[RegExp, string]> = [
    [/alphafold\s*3|alphafold3/, "AlphaFold 3"],
    [/retrieval[\s-]?augmented|检索增强生成/, "retrieval-augmented generation"],
    [/large language model|大语言模型|大模型|语言模型/, "large language model"],
    [/membership inference|成员推断|成员推理/, "membership inference attack"],
    [/federated learning|联邦学习/, "federated learning"],
    [/graph neural network|图神经网络|gnn/, "graph neural network"],
    [/diffusion\s*model|扩散模型|扩散式/, "diffusion model"],
    [/video generation|视频生成|文生视频|text[\s-]?to[\s-]?video/, "video generation"],
    [/drug discovery|药物发现|药物研发/, "drug discovery"],
    [/binding affinity|结合亲和力|亲和力/, "binding affinity"],
    [/loss function|损失函数/, "loss function"],
    [/structure prediction|结构预测/, "structure prediction"],
    [/generative model|生成模型|生成式/, "generative model"],
    [/transformer/, "Transformer"],
    [/protein[\s-]?ligand|蛋白质?[\s-]?配体|蛋白配体复合物/, "protein-ligand complex"],
    [/protein|蛋白质|蛋白/, "protein"],
    [/ligand|配体/, "ligand"],
    [/privacy|隐私|差分隐私/, "privacy"],
    [/medical|clinical|医学|医疗|临床/, "medical"],
  ];
  const terms: string[] = [];
  for (const [pattern, term] of TERM_RULES) {
    if (pattern.test(text) && !terms.includes(term)) terms.push(term);
  }

  // ── 2) 口语→学术的语境升级："怎么预测配体 / 预测配体结合"等 ──
  //    在含 配体/ligand 且语境含“预测/结合”时，把裸 ligand 升级为
  //    检索意义更强的复合概念 protein-ligand complex。
  const ligandIdx = terms.indexOf("ligand");
  if (
    ligandIdx !== -1 &&
    !terms.includes("protein-ligand complex") &&
    /预测|结合|interaction|bind|复合物|complex/i.test(rawQuery)
  ) {
    terms.splice(ligandIdx, 1, "protein-ligand complex");
  }

  // ── 3) 组装布尔检索式：含空格的短语加引号，概念间用 AND 连接 ──
  const toTerm = (t: string): string => (t.includes(" ") ? `"${t}"` : t);
  if (terms.length > 0) return terms.map(toTerm).join(" AND ");

  // ── 4) 兜底：未命中任何规则时，退回“英文词 + AND”或清洗后原文 ──
  const englishTokens =
    (rawQuery.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) ?? []).map((t) => t.toLowerCase());
  if (englishTokens.length > 0) return [...new Set(englishTokens)].join(" AND ");
  return rawQuery.trim();
}

/**
 * Semantic Scholar Graph API —— 真实科研检索后端（免费、无需 API Key）。
 *
 * 端点：GET /graph/v1/paper/search
 * 请求参数说明：
 *   - query  ：检索词（必填），直接透传用户输入；
 *   - limit  ：返回文献条数上限（取 3，避免把过长上下文灌给模型）；
 *   - fields ：指定返回的结构化字段（逗号分隔）：
 *       title / abstract / year / authors / citationCount
 * 响应结构：{ "data": [ { title, abstract, year, authors:[{name}], citationCount } ] }
 */
const SEMANTIC_SCHOLAR_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const SEARCH_LIMIT = 3;
const API_FIELDS = "title,abstract,year,authors,citationCount";
/** 请求超时上限（毫秒）：超时即中止（AbortController），避免模型无限等待。 */
const FETCH_TIMEOUT_MS = 15_000;

/** 引用编号计数器：为本次会话每篇真实检索到的文献分配全局自增 ref_id（ref_1、ref_2…）。 */
let refIdCounter = 0;

/**
 * 通用指数退避重试封装：专门应对 429（Too Many Requests）限流。
 *
 * 【为什么需要它（工程原理）】
 *   真实 API（Semantic Scholar 未认证配额约 100 次/5 分钟，且为共享配额池）在
 *   请求过密时返回 429。若直接失败退出，用户请求会“碰运气”式失败；而“立即重试”
 *   同样无效 —— 限流窗口尚未过去，只会再次 429，并把压力叠加到服务端。
 *
 *   - 指数退避：重试等待按 2^n 增长（1s → 2s → 4s），给服务端留出恢复窗口；
 *   - 随机抖动：在基础延迟上叠加 0~500ms 随机值 —— 多客户端若按同一节奏重试会
 *     形成“重试风暴（惊群）”再次打满配额，抖动把重试时刻打散，是分布式
 *     重试的标准做法（参考 AWS 等平台的退避指南）；
 *   - 有界终止：最多重试 maxRetries 次（默认 3），每次尝试又有 FETCH_TIMEOUT_MS
 *     超时兜底 —— 该函数必然在有限时间内返回，绝不陷入死循环。
 *
 * @param url      请求地址
 * @param init     原生 fetch 的 RequestInit
 * @param options  maxRetries 最大重试次数（默认 3）；signal 外部中止信号
 * @returns 最后一次 HTTP 响应（调用方需自行判断 response.ok）
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { maxRetries?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = 1_000; // 基础延迟 1s
  const maxJitterMs = 500; // 抖动上界 500ms

  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 每次尝试使用独立 AbortController 施加超时；同时监听外部 signal 以便取消。
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    lastResponse = response;

    // 仅对 429 退避重试；2xx 成功或其余错误码直接返回（调用方统一判定）。
    if (response.status !== 429 || attempt === maxRetries) return response;

    // 退避延迟 = base * 2^attempt + jitter(0~500ms)：1s → 2s → 4s。
    const delayMs = baseDelayMs * 2 ** attempt + Math.random() * maxJitterMs;
    await waitWithAbort(delayMs, options.signal);
  }
  // 循环内必然在最后一次尝试处 return，此处仅作类型收口。
  return lastResponse!;
}

/**
 * 可被外部信号打断的等待：用户取消后立即结束等待，避免无谓空等。
 */
async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** CrossRef 论文条目类型（仅声明用到的字段）。 */
interface CrossRefItem {
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  "published-print"?: { "date-parts"?: Array<Array<number | string>> };
  "published-online"?: { "date-parts"?: Array<Array<number | string>> };
  abstract?: string;
  DOI?: string;
}

/**
 * 把论文标准字段排版为统一的 Markdown 正文（Semantic Scholar 与 CrossRef 共用）。
 * 标题行中的 [ref_N] 即条目 ref_id，模型引用时直接复用。
 */
function buildMarkdownEntry(
  ref_id: string,
  title: string,
  authorNames: string,
  year: number | string,
  abstract: string,
): string {
  return [
    `## [${ref_id}] ${title}`,
    `- **作者**: ${authorNames || "未知"}`,
    `- **年份**: ${year}`,
    `- **摘要**: ${abstract}`,
  ].join("\n");
}

/**
 * 文献结构化解析（Semantic Scholar 版）：把扁平 JSON 条目转换为 RetrievalResult[]。
 *
 * @param apiData 从 Semantic Scholar payload.data 取出的论文数组
 * @returns 符合 RetrievalResult 接口的结果列表
 */
function formatRetrievalResults(
  apiData: Array<{
    title?: string;
    abstract?: string;
    year?: number;
    authors?: Array<{ name?: string }>;
    citationCount?: number;
  }>,
): RetrievalResult[] {
  return apiData.map((paper) => {
    refIdCounter += 1; // 全局自增 → ref_id 跨多次检索唯一（ref_1、ref_2…）
    const ref_id = `ref_${refIdCounter}`;
    const authorNames = (paper.authors ?? [])
      .map((a) => a.name ?? "")
      .filter(Boolean)
      .join(", ");
    const title = paper.title?.trim() || "（无标题）";
    const abstract = paper.abstract?.trim() || "（无摘要）";
    return {
      content: buildMarkdownEntry(ref_id, title, authorNames, paper.year ?? "未知", abstract),
      ref_id,
      metadata: {
        title,
        abstract,
        year: paper.year ?? null,
        authors: (paper.authors ?? []).map((a) => a.name ?? ""),
        citationCount: paper.citationCount ?? 0,
        source: "semanticscholar", // 标记来源：主数据源
      },
    };
  });
}

/**
 * 主源检索：Semantic Scholar Graph API（429 指数退避重试）。
 *
 * 契约：成功 → 返回结果数组（可能为空）；失败 → **向上抛出异常**，
 * 由上层 searchLiterature 统一决定降级（本函数不吞错，便于编排器感知故障）。
 */
async function searchSemanticScholar(
  query: string,
  signal?: AbortSignal,
): Promise<RetrievalResult[]> {
  const url = new URL(SEMANTIC_SCHOLAR_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(SEARCH_LIMIT));
  url.searchParams.set("fields", API_FIELDS);

  const response = await fetchWithRetry(url.toString(), { method: "GET" }, { signal });
  if (!response.ok) {
    // 重试耗尽仍失败：429 → 限流标记；其余错误码 → 通用错误（均抛给上层降级）。
    throw new Error(
      response.status === 429
        ? "RATE_LIMITED (Semantic Scholar)"
        : `HTTP ${response.status} ${response.statusText} (Semantic Scholar)`,
    );
  }
  const payload = (await response.json()) as {
    data?: Array<{
      title?: string;
      abstract?: string;
      year?: number;
      authors?: Array<{ name?: string }>;
      citationCount?: number;
    }>;
  };
  return formatRetrievalResults(payload.data ?? []);
}

/**
 * 从 CrossRef 条目中提取出版年份：优先印刷版 published-print，其次在线版
 * published-online；取 date-parts 第一段的年份数字。
 */
function extractCrossRefYear(item: CrossRefItem): number | string {
  const printed = item["published-print"]?.["date-parts"]?.[0]?.[0];
  if (typeof printed === "number") return printed;
  const online = item["published-online"]?.["date-parts"]?.[0]?.[0];
  return typeof online === "number" ? online : "未知";
}

/**
 * 清洗 CrossRef 摘要中的 HTML 标签：其摘要常为 JATS 风格（<jats:p> 等），
 * 用正则剔除全部标签并压缩空白，只保留纯文本供模型阅读。
 */
function stripHtmlTags(text: string | undefined): string {
  if (!text) return "（无摘要）";
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || "（无摘要）";
}

/**
 * 文献结构化解析（CrossRef 版）：把 message.items 数组转换为 RetrievalResult[]，
 * 版式与主源完全一致（buildMarkdownEntry 共用）。
 */
function formatCrossRefResults(items: CrossRefItem[]): RetrievalResult[] {
  return items.map((item) => {
    refIdCounter += 1;
    const ref_id = `ref_${refIdCounter}`;
    const authorNames = (item.author ?? [])
      .map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.name || "")
      .filter(Boolean)
      .join(", ");
    const title = item.title?.[0]?.trim() || "（无标题）";
    const year = extractCrossRefYear(item);
    const abstract = stripHtmlTags(item.abstract);
    return {
      content: buildMarkdownEntry(ref_id, title, authorNames, year, abstract),
      ref_id,
      metadata: {
        title,
        abstract,
        year: typeof year === "number" ? year : null,
        authors: (item.author ?? [])
          .map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.name || "")
          .filter(Boolean),
        doi: item.DOI ?? null,
        source: "crossref", // 标记来源：备用数据源
      },
    };
  });
}

/**
 * 备用源检索：CrossRef REST API。
 *
 * 接口：https://api.crossref.org/works?query=<词>&rows=<条数>
 * 数据路径：payload.message.items[]；字段映射见 formatCrossRefResults。
 * 同样复用 fetchWithRetry（429 退避），失败向上抛出由 searchLiterature 兜底。
 */
async function searchCrossRef(query: string, signal?: AbortSignal): Promise<RetrievalResult[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${SEARCH_LIMIT}`;
  const response = await fetchWithRetry(url, { method: "GET" }, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} (CrossRef)`);
  }
  const payload = (await response.json()) as {
    message?: { items?: CrossRefItem[] };
  };
  return formatCrossRefResults(payload.message?.items ?? []);
}

/** 判断一组检索结果是否包含可用摘要（用于决定是否触发 OpenAlex 摘要兜底）。 */
function hasAbstracts(results: RetrievalResult[]): boolean {
  return results.some((r) => {
    const a = r.metadata?.abstract;
    return typeof a === "string" && a.length > 0 && a !== "（无摘要）";
  });
}

/** OpenAlex 文献条目类型（仅声明用到的字段）。 */
interface OpenAlexWork {
  title?: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  publication_year?: number;
  abstract_inverted_index?: Record<string, number[]>;
  doi?: string;
}

/**
 * 还原 OpenAlex 倒排索引摘要（本阶段最核心的工程点）。
 *
 * 【倒排索引原理】
 *   OpenAlex 不直接返回“摘要字符串”，而是返回 词 → 位置数组 的映射，例如：
 *     { "Membership": [0], "inference": [1], "attacks": [2] }
 *   表示 “Membership” 出现在第 0 位、“inference” 第 1 位…。
 *   这种存储是为全文检索设计的（按词倒排、命中即定位，查询高效），
 *   代价是文本顺序被打散，无法直接读出可读句子。
 *
 * 【还原逻辑】
 *   1. 遍历映射，把每个词按它出现的每一个位置展开为 (位置, 词) 二元组；
 *   2. 按位置升序排序（同一词可能出现多次，展开后自然保序）；
 *   3. 依次取出词并以空格连接，即还原出原始摘要文本。
 */
function reconstructAbstract(
  invertedIndex: Record<string, number[]> | undefined,
): string {
  if (!invertedIndex) return "（无摘要）";
  const positioned: Array<{ pos: number; word: string }> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) positioned.push({ pos, word });
  }
  positioned.sort((a, b) => a.pos - b.pos);
  const text = positioned.map((e) => e.word).join(" ");
  return text.trim() || "（无摘要）";
}

/**
 * 文献结构化解析（OpenAlex 版）：results 数组 → RetrievalResult[]。
 * 版式与其余数据源一致（buildMarkdownEntry 共用）。
 */
function formatOpenAlexResults(works: OpenAlexWork[]): RetrievalResult[] {
  return works.map((work) => {
    refIdCounter += 1;
    const ref_id = `ref_${refIdCounter}`;
    const authorNames = (work.authorships ?? [])
      .map((a) => a.author?.display_name ?? "")
      .filter(Boolean)
      .join(", ");
    const title = work.title?.trim() || "（无标题）";
    const year = work.publication_year ?? "未知";
    const abstract = reconstructAbstract(work.abstract_inverted_index);
    return {
      content: buildMarkdownEntry(ref_id, title, authorNames, year, abstract),
      ref_id,
      metadata: {
        title,
        abstract,
        year: typeof year === "number" ? year : null,
        authors: (work.authorships ?? [])
          .map((a) => a.author?.display_name ?? "")
          .filter(Boolean),
        doi: work.doi ?? null,
        source: "openalex", // 标记来源：第三级（摘要兜底）
      },
    };
  });
}

/**
 * 第三级检索：OpenAlex（终极摘要防线）。
 *
 * 接口：/works?search=<词>&per_page=<条数>
 * 数据路径：payload.results[]；摘要为 abstract_inverted_index（倒排索引）。
 * 同样复用 fetchWithRetry（429 退避），失败向上抛出由 searchLiterature 收尾。
 */
async function searchOpenAlex(query: string, signal?: AbortSignal): Promise<RetrievalResult[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${SEARCH_LIMIT}`;
  const response = await fetchWithRetry(url, { method: "GET" }, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} (OpenAlex)`);
  }
  const payload = (await response.json()) as { results?: OpenAlexWork[] };
  return formatOpenAlexResults(payload.results ?? []);
}

/**
 * 三级降级检索（核心编排函数）。
 *
 * 【链路】
 *   L1 Semantic Scholar（主）成功 → 直接交付；
 *   L2 CrossRef（备）：主源失败后接管 —— 有命中且有摘要 → 直接交付；
 *      无命中 / 无摘要 → 继续进入 L3；
 *   L3 OpenAlex（终极摘要防线）：当主备均失败，或前序结果整体缺摘要时触发，
 *      专门弥补“检索到文献但读不到摘要”的最后一公里。
 *
 * 【可用性设计】
 *   - 每一级故障都被捕获并记录，只损失该级能力，不会向上崩溃；
 *   - OpenAlex 兜底仍失败时，若 CrossRef 曾有结果则退回（保底标题级信息）；
 *   - 全部服务级失败才返回“三级均不可用”错误条目（而非抛异常），
 *     保证 execute 返回值永远可被 LLM 消费。
 */
async function searchLiterature(query: string, signal?: AbortSignal): Promise<RetrievalResult[]> {
  const tag = (results: RetrievalResult[]): void => {
    for (const r of results) r.metadata.matched_query = query; // 回填触发词便于溯源
  };
  const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // ── 第一级：Semantic Scholar（主）────────────────────────────
  let primaryFailed = false;
  try {
    const results = await searchSemanticScholar(query, signal);
    tag(results);
    return results;
  } catch (primaryErr) {
    primaryFailed = true;
    console.warn(`[ScholarGuardian] 主源 Semantic Scholar 失败：${errMsg(primaryErr)}`);
  }

  // ── 第二级：CrossRef（备）─────────────────────────────────────
  let crossrefResults: RetrievalResult[] | undefined;
  let crossrefFailed = false;
  try {
    crossrefResults = await searchCrossRef(query, signal);
    tag(crossrefResults);
    // 有命中且含摘要 → 直接交付；无命中或无摘要 → 继续落入第三级。
    if (crossrefResults.length > 0 && hasAbstracts(crossrefResults)) {
      return crossrefResults;
    }
  } catch (backupErr) {
    crossrefFailed = true;
    console.warn(`[ScholarGuardian] 备用源 CrossRef 失败：${errMsg(backupErr)}`);
  }

  // ── 第三级：OpenAlex（终极摘要防线）───────────────────────────
  // 触发情形：① 主备均失败；② CrossRef 结果整体无摘要 / 无命中。
  if (!crossrefFailed) {
    console.warn("[ScholarGuardian] 前序数据源无摘要，已降级至 OpenAlex 获取摘要。");
  } else {
    console.warn("[ScholarGuardian] 主备源均失败，降级至 OpenAlex。");
  }
  let openalexFailed = false;
  try {
    const results = await searchOpenAlex(query, signal);
    tag(results);
    if (results.length > 0) return results;
  } catch (openalexErr) {
    openalexFailed = true;
    console.error(`[ScholarGuardian] 第三级 OpenAlex 失败：${errMsg(openalexErr)}`);
  }

  // ── 收尾兜底 ─────────────────────────────────────────────────
  if (crossrefResults && crossrefResults.length > 0) return crossrefResults; // 保底标题级结果
  if (primaryFailed || crossrefFailed || openalexFailed) {
    return [
      {
        content:
          "外部检索服务（Semantic Scholar、CrossRef 和 OpenAlex）均不可用，请检查网络或稍后重试。",
        ref_id: "service_error",
        metadata: { source: "error", matched_query: query },
      },
    ];
  }
  return []; // 链路正常但零命中
}

/* =====================================================================
 * 四、后置校验与反思闭环（最终阶段）
 * ===================================================================== */

/**
 * 会话级“已检索真实文献”引用集合 —— 后置校验的判定依据。
 *
 * 说明：接入真实后端后，合法引用 = 本次会话中 scholar_retrieve 真实返回的
 * ref_id（ref_1、ref_2…）。工具每次成功检索都会把返回的 ref_id 登记进本集合；
 * 校验器只放行集合内的引用，集合外的方括号标识一律判为幻觉引用。
 * 集合在 session_start 时清空，避免跨会话残留旧引用。
 */
const retrievedRefIds = new Set<string>();

/**
 * 方括号引用格式识别正则（V1.0 启发式）。
 *
 * 目标形态：方括号包裹的"类标识符"，例如：
 *   [10.1000/example.2023.0421]（DOI） / [arXiv:2401.00042]
 * 仅捕获以字母或数字开头、由 ID 安全字符（字母/数字/._-/:）组成且长度 >= 4
 * 的串，避免把 [1]、[] 等非引用方括号纳入候选。
 */
const REF_TOKEN_REGEX = /\[([A-Za-z0-9][A-Za-z0-9._\-\/:]{3,})\]/g;

/**
 * 提取正文中的候选引用 ID（自动去重）。
 *
 * 附加启发式过滤：不含任何分隔符（. / : - _）且长度 < 10 的纯短词
 * （如 [1]、[text]）大概率是编号或普通方括号内容，直接跳过以降低误报。
 */
function extractCandidateRefIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(REF_TOKEN_REGEX)) {
    const token = match[1];
    const hasSeparator = /[.\/:_-]/.test(token);
    if (!hasSeparator && token.length < 10) continue;
    ids.add(token);
  }
  return [...ids];
}

/**
 * 从 assistant 消息中提取"可见正文"。
 *
 * 为什么只取可见正文：思考草稿（thinking 块）与工具调用块不应触发告警 ——
 * 模型可能在草稿中推演各种候选引用；只有最终呈现给用户的事实陈述才需要
 * 接受"引用必须真实存在"的约束。content 为内容块数组：正文在
 * type==="text" 块内；thinking（type==="thinking"）与 toolCall 块被忽略。
 */
function extractVisibleText(message: { role?: string; content?: unknown }): string {
  if (message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content; // 兼容纯字符串形式的内容
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** 每个非法引用允许的自动纠错最大轮数（防止模型始终不改 → 修正死循环烧 token）。 */
const MAX_CORRECTION_ROUNDS = 3;

/**
 * 会话级运行时状态（均在 session_start 时复位）：
 *   - correctionCounts：ref_id → 已触发自动纠错次数（跨消息累计，供上限判断）；
 *   - scanStates：流式增量扫描游标（messageKey → 已扫描长度 + 已报告 ID 集）。
 */
const correctionCounts = new Map<string, number>();
const scanStates = new Map<string, { scannedUpTo: number; reported: Set<string> }>();

/**
 * 组装"自我修正"用户消息。
 * 该消息以 user 角色注入对话：模型读到它等于收到一条"人类要求改稿"的指令，
 * 从而在同一轮对话内重新审视并修正自己的引用 —— 即"反思闭环"。
 */
function buildCorrectionMessage(feedbacks: string[]): string {
  const list = feedbacks.map((f) => `- ${f}`).join("\n");
  return (
    "【ScholarGuardian 引用校验提示】你上一条回答中存在未收录于检索结果的引用，请立即自我修正：\n" +
    list +
    "\n请删除上述引用，或改用 scholar_retrieve 返回结果中的真实 ref_id" +
    "（形如 ref_1）后重新输出修正内容。"
  );
}

/* =====================================================================
 * 五、全文解析工具支撑（第九阶段）
 * ===================================================================== */

/**
 * TS + Python 混合架构在 RAG 全文解析中的优势：
 *
 *   - 领域专业化：PyMuPDF 对 PDF 的文本层还原、版面顺序、嵌入字体与加密/损坏
 *     文件处理成熟度远高于纯 JS 生态；让“专业的事交给专业的库”。
 *   - 职责分离：TS 侧负责编排（Pi 集成、网络下载、临时文件、生命周期），
 *     Python 侧只做一件事 —— PDF → 纯文本，单一职责、易测试、可单独复用。
 *   - 进程隔离：解析崩溃（段错误 / OOM）不会拖垮 pi 主进程；stdout 传正文、
 *     stderr 传错误、退出码表达失败类型，契约清晰。
 *   - 成本可控：按需进程拉起，无长驻 Python 服务，不引入额外运维面。
 */

/** 解析器脚本路径：与扩展同目录（.pi/extensions/pdf_fulltext_parser.py）。 */
const PDF_PARSER_SCRIPT = join(__dirname, "pdf_fulltext_parser.py");
/** PDF 临时下载目录：扩展目录下 data/temp/，随项目隔离、便于清理。 */
const PDF_TEMP_DIR = join(__dirname, "data", "temp");
/** PDF 下载通常大于 JSON 响应，超时放宽到 60s。 */
const PDF_TIMEOUT_MS = 60_000;
/** 保留的全文前缀字符数（与 pdf_fulltext_parser.py 保持一致）。 */
const FULLTEXT_TRUNCATE_CHARS = 8000;
/** 是否开启 Python 环境探测日志：设置环境变量 SCHOLAR_DEBUG=1 时输出解释器/PyMuPDF 状态。 */
const gEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env;
const PDF_DEBUG = gEnv?.SCHOLAR_DEBUG === "1";

/** readPdfFulltext 的结构化返回：成功给 text，失败给 reason。 */
interface PdfReadOutcome {
  ok: boolean;
  text?: string;
  reason?: string;
}

/**
 * 探测指定 Python 解释器：打印其可执行路径与 PyMuPDF 可用性（排障日志用）。
 * 通过独立 execSync 分别探测解释器与 fitz，避免一条命令内多语句在 Windows
 * cmd 下的换行转义问题。
 */
function probePython(pythonBin: string): string {
  let executable: string;
  try {
    executable =
      execSync(`"${pythonBin}" -c "import sys; print(sys.executable)"`, {
        encoding: "utf8",
        timeout: 15_000,
      }).trim() || "未知";
  } catch (err) {
    executable = `不可用（${err instanceof Error ? err.message.split("\n")[0] : String(err)}）`;
  }
  let fitzState: string;
  try {
    execSync(`"${pythonBin}" -c "import fitz; print('ok')"`, {
      encoding: "utf8",
      timeout: 15_000,
    });
    fitzState = "PyMuPDF 可用";
  } catch {
    fitzState = "缺少 PyMuPDF（脚本已含自动安装逻辑，或手动: python -m pip install PyMuPDF）";
  }
  return `解释器 ${pythonBin} → ${executable}；${fitzState}`;
}

/**
 * 下载 PDF → 调用 Python 解析器 → 返回截断后的纯文本。
 *
 * 路径说明：__dirname 指向扩展源文件所在目录，解析器与之同目录 ——
 * 无论 pi 的 cwd 在哪里都能正确定位脚本（若未来改为 ESM，需换用
 * import.meta.url 方案，此处为 CommonJS 加载假设）。
 *
 * @param pdfUrl     论文 PDF 下载链接（由调用方提供）
 * @param paperTitle 论文标题（用于生成可读的临时文件名与日志）
 * @param signal     外部中止信号
 */
async function readPdfFulltext(
  pdfUrl: string,
  paperTitle: string,
  signal?: AbortSignal,
): Promise<PdfReadOutcome> {
  // 清洗标题生成安全文件名（去除路径分隔符与非法字符）。
  const safeTag = paperTitle.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "untitled";
  const pdfPath = join(PDF_TEMP_DIR, `fulltext_${Date.now()}_${safeTag}.pdf`);

  try {
    // ── 0) Python 环境探测（排障日志）────────────────────────────
    // 开启方式：设置环境变量 SCHOLAR_DEBUG=1 后启动 pi。
    // 用途：定位“明明 pip install 过却 ImportError”的解释器隔离问题 ——
    //   打印的是 pi 进程 PATH 下实际调用的解释器及其 fitz 状态。
    if (PDF_DEBUG) {
      for (const bin of ["python", "python3"]) {
        console.log(`[ScholarGuardian][debug] ${probePython(bin)}`);
      }
    }

    // ── 1) 下载 PDF 到临时目录 ───────────────────────────────────
    mkdirSync(PDF_TEMP_DIR, { recursive: true });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), PDF_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(pdfUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) {
      return { ok: false, reason: `PDF 下载失败：HTTP ${response.status} ${response.statusText}` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(pdfPath, buffer);

    // ── 2) execSync 调用 Python 解析器 ───────────────────────────
    // 先试 python，再退而求其次试 python3（不同系统命名差异）。
    let parserStdout = "";
    let pythonError: unknown = null;
    for (const pythonBin of ["python", "python3"]) {
      try {
        parserStdout = execSync(
          `"${pythonBin}" "${PDF_PARSER_SCRIPT}" "${pdfPath}"`,
          { encoding: "utf8", timeout: PDF_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        );
        break;
      } catch (err) {
        pythonError = err; // 记录后尝试下一个解释器
      }
    }
    if (!parserStdout) {
      const reason = pythonError instanceof Error ? pythonError.message : String(pythonError);
      return { ok: false, reason: `Python 解析调用失败：${reason}` };
    }

    // ── 3) 双重保险截断并返回 ───────────────────────────────────
    const text = parserStdout.slice(0, FULLTEXT_TRUNCATE_CHARS);
    if (!text.trim()) {
      return { ok: false, reason: "PDF 解析未返回任何文本（可能为扫描件）。" };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    // 无论成败都清理临时 PDF，避免磁盘堆积；清理失败不阻塞返回。
    try {
      rmSync(pdfPath, { force: true });
    } catch {
      /* 忽略清理异常 */
    }
  }
}

/** 向量化脚本路径：与扩展同目录（.pi/extensions/pdf_vectorizer.py）。 */
const PDF_VECTORIZER_SCRIPT = join(__dirname, "pdf_vectorizer.py");

/** 语义检索返回的文本块（对应 pdf_vectorizer.py search 输出）。 */
interface PdfVectorChunk {
  text: string;
  section: string;
  title: string;
  chunk_index: number;
  distance: number | null;
}
interface PdfVectorOutcome {
  ok: boolean;
  chunks?: PdfVectorChunk[];
  reason?: string;
}

/**
 * 调用 pdf_vectorizer.py 子命令并返回 stdout（JSON）。
 * 与解析器一致：先试 python 再试 python3；失败抛出（携带 stderr 信息）。
 * 首次调用会触发依赖自动安装与模型加载，超时放宽。
 */
function runVectorizer(args: string[], timeoutMs = 600_000): string {
  let lastErr: unknown = null;
  for (const pythonBin of ["python", "python3"]) {
    try {
      return execSync(
        `"${pythonBin}" "${PDF_VECTORIZER_SCRIPT}" ${args
          .map((a) => `"${a}"`)
          .join(" ")}`,
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(lastErr instanceof Error ? lastErr.message : String(lastErr));
}

/**
 * 全文“向量化问答”编排：下载 PDF → 结构化切片+Embedding 入库（index_paper）
 * → 用用户原始问题做语义检索（search_paper）→ 返回 Top-3 相关片段。
 */
async function indexAndSearchPdf(
  pdfUrl: string,
  paperTitle: string,
  query: string,
  signal?: AbortSignal,
): Promise<PdfVectorOutcome> {
  const safeTag = paperTitle.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "untitled";
  const pdfPath = join(PDF_TEMP_DIR, `vec_${Date.now()}_${safeTag}.pdf`);
  try {
    // 1) 下载 PDF 到临时目录
    mkdirSync(PDF_TEMP_DIR, { recursive: true });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), PDF_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(pdfUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) return { ok: false, reason: `PDF 下载失败：HTTP ${response.status}` };
    writeFileSync(pdfPath, Buffer.from(await response.arrayBuffer()));

    // 2) 建立/更新向量索引（结构化切片 → Embedding → ChromaDB 持久化）
    const idxOut = JSON.parse(runVectorizer(["index", pdfPath, paperTitle])) as {
      ok?: boolean;
      indexed_chunks?: number;
    };
    if (!idxOut.ok) return { ok: false, reason: "向量索引失败（详见 stderr）" };

    // 3) 用用户“原始问题”做语义检索（不走查询重写，保留提问意图）
    const sOut = JSON.parse(runVectorizer(["search", query, "3"])) as {
      ok?: boolean;
      results?: PdfVectorChunk[];
    };
    if (!sOut.ok || !sOut.results) return { ok: false, reason: "语义检索失败（详见 stderr）" };
    return { ok: true, chunks: sOut.results };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      rmSync(pdfPath, { force: true });
    } catch {
      /* 忽略清理异常 */
    }
  }
}

/* =====================================================================
 * 七、意图路由与双层记忆 —— 模块级支撑（第十二阶段）
 * ===================================================================== */

/** 长期记忆文件：随项目隔离于扩展 data/ 目录，跨会话/重启持久化。 */
const MEMORY_FILE = join(__dirname, "data", "memory.json");

interface MemoryEntry {
  id: string;
  content: string;
  timestamp: string;
}

/** 读取长期记忆（文件不存在/损坏时返回空数组，不阻断主流程）。 */
function loadMemory(): MemoryEntry[] {
  try {
    if (!existsSync(MEMORY_FILE)) return [];
    const raw = readFileSync(MEMORY_FILE, "utf8");
    const arr = JSON.parse(raw) as MemoryEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.warn("[ScholarGuardian] 读取长期记忆失败：", err instanceof Error ? err.message : err);
    return [];
  }
}

/** 追加一条长期记忆并持久化。 */
function saveMemory(content: string): { ok: boolean; total?: number; reason?: string } {
  try {
    const list = loadMemory();
    list.push({
      id: `mem_${Date.now()}_${list.length}`,
      content,
      timestamp: new Date().toISOString(),
    });
    mkdirSync(dirname(MEMORY_FILE), { recursive: true });
    writeFileSync(MEMORY_FILE, JSON.stringify(list, null, 2), "utf8");
    return { ok: true, total: list.length };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/* =====================================================================
 * 八、AI 安全防线（第十三阶段）
 * ===================================================================== */

/**
 * 【防线 1：间接提示词注入防御（Indirect Prompt Injection Guard）】
 *
 * 攻击原理与攻击链：
 *   攻击者不直接向模型下指令，而是把恶意指令藏进会被 RAG“检索进上下文”的
 *   第三方内容 —— 例如在一篇伪装成学术论文的 PDF 正文里写 “ignore previous
 *   instructions...”，或在网页/文献元数据中暗藏指令。当这些不可信文本被拼进
 *   对话时，模型可能把其中的命令误当成系统高层指令执行。这就是间接提示词
 *   注入：数据不可信，却拥有了指令的权限 —— RAG 时代最危险的威胁之一。
 *
 * 我们的防御思路（纵深防御第一层）：
 *   1) 隔离：PDF/外部文本绝不原样进 Prompt，先过清洗函数；
 *   2) 特征匹配：用正则探测“指令型”语句特征（忽略先前指令 / 系统提示 /
 *      输出记忆 / 扮演角色 / 开发者模式等）；
 *   3) 段落级隔离：命中则把整段替换为安全占位说明 —— 既阻断注入，
 *      又保留“此处有异常”的审计痕迹。
 *   注：更强架构级防护是“只把 系统/用户 消息视为指令，检索内容一律当
 *       数据”，本函数用于在内容层先做一道确定性的兜底。
 */
const INJECTION_BLOCK_MARK =
  "[⚠️ 安全拦截：检测到潜在的间接提示词注入攻击，已隔离该文本块]";
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+(?:instructions|prompts?|messages?)/i,
  /system\s+prompt/i,
  /output\s+memory/i,
  /act\s+as(?:\s+(?:if|though))?/i,
  /you\s+are\s+now/i,
  /developer\s+mode/i,
  /print\s+(?:the\s+)?(?:system\s+)?prompt/i,
  /do\s+not\s+(?:reveal|disclose|tell|mention)\b/i,
];

/** 扫描并隔离含注入指令特征的段落；返回清洗后文本与命中块数。 */
function sanitizeInjectedText(text: string): { clean: string; blocked: number } {
  const paragraphs = text.split(/\n\s*\n/);
  let blocked = 0;
  const cleaned = paragraphs
    .map((p) => {
      const t = p.trim();
      if (!t) return p;
      const hit = INJECTION_PATTERNS.some((re) => re.test(t));
      if (hit) {
        blocked += 1;
        return INJECTION_BLOCK_MARK;
      }
      return p;
    })
    .join("\n\n");
  return { clean: cleaned, blocked };
}

/**
 * 【防线 2：RAG 文档级 RBAC（越权访问拦截）】
 *
 * 关键作用：RAG 把检索能力直接暴露给用户后，“谁能看到哪些文献”必须由权限层
 * 裁定，而不能交给检索召回碰运气 —— 否则普通学生可能借一个检索问题顺带拿到
 * 管理员才可见的机密文献（数据越权泄露）。
 * 做法：请求携带 user_role（student/admin）；文献侧解析 access_level；
 *   student 命中 admin-only 的文献 → 过滤拦截、不下发、不登记引用集，并给出
 *   明确提示。真实系统应将 access_level 写入索引元数据/权限服务；本演示对
 *   缺失字段使用硬编码规则（命中下述 DOI 前缀或标题含机密标记即视为机密）。
 */
const ADMIN_ONLY_DOI_PREFIXES: readonly string[] = ["10.55277/researchhub."]; // 演示用机密标识
const ACCESS_LEVEL_PUBLIC = "public";
const ACCESS_LEVEL_ADMIN = "admin-only";

/** 解析一条检索结果的访问级别：优先元数据，缺失时用硬编码演示规则兜底。 */
function resolveAccessLevel(item: RetrievalResult): "public" | "admin-only" {
  const metaLevel = item.metadata?.access_level;
  if (metaLevel === ACCESS_LEVEL_ADMIN || metaLevel === ACCESS_LEVEL_PUBLIC) {
    return metaLevel;
  }
  const doi = typeof item.metadata?.doi === "string" ? item.metadata.doi : "";
  const title = typeof item.metadata?.title === "string" ? item.metadata.title : "";
  if (ADMIN_ONLY_DOI_PREFIXES.some((p) => doi.startsWith(p)) || title.includes("（机密）")) {
    return ACCESS_LEVEL_ADMIN;
  }
  return ACCESS_LEVEL_PUBLIC;
}

/* =====================================================================
 * 九、Extension 入口（骨架）
 * ===================================================================== */

/**
 * ScholarGuardian Extension 入口工厂函数。
 *
 * 依据 Pi 官方 Extension 规范：
 *   - 采用默认导出（default export）的工厂函数形式；
 *   - Pi 在加载本扩展时会调用该函数，并注入 ExtensionAPI 实例 pi；
 *   - 工厂函数内部只做"订阅声明"，不在此处启动任何后台资源
 *     （后台资源的启动/清理应放在 session_start / session_shutdown 中）。
 *
 * @param pi Pi 提供的 ExtensionAPI，用于注册事件监听、自定义工具等。
 */
export default function (pi: ExtensionAPI): void {
  // 扩展加载完成的标志性日志（Pi 加载并执行本工厂函数即打印）。
  console.log("[ScholarGuardian] Extension loaded.");

  // -------------------------------------------------------------------
  // 生命周期事件一：session_start
  //
  // 触发时机：会话启动 / 载入 / 热重载（reload）完成时触发。
  //   event.reason 取值："startup" | "reload" | "new" | "resume" | "fork"
  //
  // 【后续阶段 TODO】此处将初始化会话级资源，例如：
  //   - 建立学术 API 客户端连接 / 配置加载；
  //   - 初始化检索索引与核验器实例；
  //   - 恢复本次会话的核验状态。
  // -------------------------------------------------------------------
  pi.on("session_start", async (_event, _ctx) => {
    // 会话级运行时状态复位：清空"引用纠错计数"、"流式增量扫描游标"与
    // "已检索引用集合"，避免跨会话 / 热重载后残留旧状态导致误判或状态泄漏。
    correctionCounts.clear();
    scanStates.clear();
    retrievedRefIds.clear();
  });

  // -------------------------------------------------------------------
  // 生命周期事件二：session_shutdown
  //
  // 触发时机：会话运行时被销毁前触发（退出 / 切换 / 重载等场景）。
  //   event.reason 取值："quit" | "reload" | "new" | "resume" | "fork"
  //
  // 【后续阶段 TODO】此处将释放 session_start 中占用的资源，例如：
  //   - 关闭网络连接、清理定时器与句柄；
  //   - 持久化尚未落盘的核验状态。
  // -------------------------------------------------------------------
  pi.on("session_shutdown", async (_event, _ctx) => {
    // 阶段一：占位符，暂不实现任何业务逻辑。
  });

  // -------------------------------------------------------------------
  // 事件三：before_agent_start —— 动态防御注入（第二阶段核心）
  //
  // 【事件原理】
  //   触发时机：用户每次提交输入之后、Agent 循环（LLM 调用）开始之前。
  //   作用：回调可返回 { systemPrompt } 来改写本轮发送给模型的
  //   System Prompt，也可返回 { message } 注入额外上下文。
  //
  // 【追加而非覆盖原理】
  //   本回调返回的 systemPrompt 采用"拼接"而非"替换"：
  //     systemPrompt 字段 = event.systemPrompt + 新段落
  //   - event.systemPrompt 是 Pi 已按 系统提示 + 上下文文件 + 其他扩展
  //     链式拼接好的完整 Prompt，我们取其"现值"再在末尾追加，
  //     因此原有内容一字不丢、不会被覆盖；
  //   - 多扩展场景下 Pi 按加载顺序链式传递 systemPrompt：
  //     后执行的回调看到的是前面回调追加后的结果，扩展间互不干扰；
  //   - 返回值省略 systemPrompt（或整体返回 undefined）＝ 不改动 Prompt。
  //
  // 【作用域说明】
  //   此修改只对本轮生成生效、不会写入会话历史 —— 属于"每轮动态"防御：
  //   只有检测到科研意图的那一轮才启用引用约束，其余场景零负担。
  // -------------------------------------------------------------------
  pi.on("before_agent_start", async (event, _ctx) => {
    // 第 1 步：意图识别。非科研意图直接返回 undefined → System Prompt 保持原样。
    if (!isResearchIntent(event.prompt)) {
      return;
    }

    // 第 2 步：命中科研意图 → 在原 System Prompt 末尾动态追加防御指令。
    return {
      systemPrompt: `${event.systemPrompt}\n\n${SCHOLAR_GUARDIAN_DEFENSE_PROMPT}`,
    };
  });

  // -------------------------------------------------------------------
  // 自定义工具：scholar_retrieve（第三阶段）
  //
  // 【注册规范】
  //   通过 pi.registerTool 注册，Pi 会将该工具注入系统提示并允许 LLM 调用：
  //     - name        ：工具唯一标识（LLM 调用名，蛇形命名），必须全局唯一
  //     - label       ：人类可读名称
  //     - description ：功能描述，LLM 据此决定“何时调用 / 传什么参数”
  //     - parameters  ：TypeBox Schema，约束入参（query 为必填 string）
  //     - execute     ：实际执行体，规范签名顺序为
  //       (toolCallId, params, signal, onUpdate, ctx)；
  //       params 类型由上面的 TypeBox Schema 推断；
  //       ctx 提供会话管理、UI 交互等能力（本阶段暂未使用）。
  //
  // 【返回值规范】
  //   execute 必须返回 { content, details }：
  //     - content：发送给 LLM 的内容块数组（此处将 RetrievalResult 序列化为
  //       JSON 文本，便于模型结构化消费 / 后续核验环节解析）；
  //     - details：扩展内部使用的附加信息，不直接进入模型上下文。
  //
  // 【阶段说明】
  //   第五至八阶段演进为三级降级检索（Semantic Scholar → CrossRef → OpenAlex），
  //   支持 429 退避、HTML / 倒排摘要解析；任何真实来源返回的 ref_id 都会登记进
  //   会话级引用集，后置校验据此放行真实引用。
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "scholar_retrieve",
    label: "Scholar Retrieve",
    description:
      "根据用户给出的查询词检索真实学术文献（Semantic Scholar → CrossRef → OpenAlex 多源自动降级），返回结构化引用片段列表（含 ref_id 与元数据）。" +
      "每次最多返回 3 条；全部服务不可用时返回错误提示。回答引用时请使用返回结果中的 ref_id。",
    parameters: scholarRetrieveParams,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      // 0. 查询重写（Query Rewriting）：在任何外部 API 调用之前完成，
      //    把口语化/模糊查询规整为学术检索式，提升召回率。
      const rawQuery = params.query;
      const optimizedQuery = rewriteQuery(rawQuery);

      // 1. 三级降级检索：Semantic Scholar → CrossRef → OpenAlex（摘要兜底）；
      //    使用优化后的检索式；函数保证返回结果数组或单条错误条目
      //   （含 429 退避与超时兜底，信号可取消）。
      const results: RetrievalResult[] = await searchLiterature(optimizedQuery, signal);

      // 2. RBAC 越权拦截（防线二）：student 角色不得接触 admin-only 文献。
      //    先过滤再登记/展示 —— 被拦截文献既不进入引用集，也不进入模型上下文。
      const denied: RetrievalResult[] = [];
      const allowed = results.filter((r) => {
        if (r.metadata?.source === "error") return true; // 错误条目不是文献，放行
        if (params.user_role === "student" && resolveAccessLevel(r) === "admin-only") {
          denied.push(r);
          return false;
        }
        return true;
      });
      if (denied.length > 0) {
        console.warn(
          `[ScholarGuardian] RBAC：student 角色已拦截 ${denied.length} 条 admin-only 文献。`,
        );
      }

      // 3. 把通过权限过滤的真实来源 ref_id 登记进会话级引用集，供后置校验放行
      //    （真实引用不应被误判为幻觉引用）。
      for (const r of allowed) {
        if (
          r.metadata?.source === "semanticscholar" ||
          r.metadata?.source === "crossref" ||
          r.metadata?.source === "openalex"
        ) {
          retrievedRefIds.add(r.ref_id);
        }
      }
      const realSource =
        allowed.find((r) => r.metadata?.source !== "error")?.metadata?.source ?? "none";
      const sourceLabel =
        realSource === "crossref"
          ? "CrossRef"
          : realSource === "openalex"
            ? "OpenAlex"
            : realSource === "semanticscholar"
              ? "Semantic Scholar"
              : "未知";
      const failed = allowed.some((r) => r.metadata?.source === "error");
      const isEmpty = !failed && allowed.length === 0;
      const lockLine =
        denied.length > 0
          ? `🔒 权限不足：您无权访问该机密文献。（已拦截 ${denied.length} 条 admin-only 条目）`
          : null;

      // 4. 组装返回内容：content 为模型可见的 JSON 文本，details 附带统计。
      let text: string;
      if (failed) {
        text = `[ScholarGuardian] 检索失败（错误详情见下方条目）：\n${JSON.stringify(allowed, null, 2)}`;
      } else if (isEmpty) {
        text =
          lockLine ??
          "[ScholarGuardian] 未检索到与查询相关的文献，请尝试更换关键词。";
      } else {
        // 返回结果顶部提示用户系统已做查询优化（透明可观测）；
        // 有被拦截的机密文献时追加明确的权限提示。
        text =
          `🔍 已将您的查询优化为学术检索式: ${optimizedQuery}\n\n` +
          `[ScholarGuardian 检索结果（${sourceLabel}）]\n${JSON.stringify(allowed, null, 2)}` +
          (lockLine ? `\n\n${lockLine}` : "");
      }
      return {
        content: [{ type: "text", text }],
        details: {
          count: allowed.length,
          rawCount: results.length,
          deniedCount: denied.length,
          user_role: params.user_role,
          source: failed ? "error" : realSource,
          mock: false,
          optimizedQuery, // 便于排障/日志确认实际发往 API 的检索式
          rewrittenFrom: rawQuery,
        },
      };
    },
  });

  // -------------------------------------------------------------------
  // 自定义工具：scholar_read_fulltext（第九阶段）
  //
  // 职责：下载指定 PDF → 交给 Python 解析器抽取全文（前 8000 字符）→
  //       以 RetrievalResult 结构返回，供模型回答“论文内部细节”类问题。
  // 使用前提（注释说明）：pdf_url 需来自可公开下载的 PDF 链接（如 arXiv
  //   openAccess PDF）；本阶段由模型/用户显式提供，后续可与检索结果联动。
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "scholar_read_fulltext",
    label: "Scholar Read Fulltext",
    description:
      "下载并解析指定 PDF 论文的全文，并通过向量语义检索定位与用户问题最相关的" +
      "片段，用于回答论文内部的微观细节问题。若下载/索引/检索失败会明确返回原因。",
    parameters: Type.Object({
      pdf_url: Type.String({ description: "论文 PDF 的可下载链接（公开地址）" }),
      paper_title: Type.String({ description: "论文标题（用于标识与索引元数据）" }),
      query: Type.String({
        description:
          "用户的原始问题（须为原句而非改写后的检索词，用于语义检索最相关段落）",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const outcome = await indexAndSearchPdf(
        params.pdf_url,
        params.paper_title,
        params.query,
        signal,
      );

      if (outcome.ok && outcome.chunks && outcome.chunks.length > 0) {
        // 命中片段属于本次会话“可引用材料”：登记固定 ref_id 供后置校验放行。
        retrievedRefIds.add("fulltext_1");
        // 【防线一：间接提示词注入清洗】任何来自 PDF 的文本在拼入上下文前
        // 都必须过清洗器；命中指令特征（如 “ignore previous instructions”、
        // “system prompt”、“output memory”、“act as”）的段落整体替换为隔离标记。
        let sanitizedBlocks = 0;
        const safeChunks = outcome.chunks.map((c) => {
          const { clean, blocked } = sanitizeInjectedText(c.text);
          sanitizedBlocks += blocked;
          return { ...c, text: clean };
        });
        const parts = [
          "以下是基于语义向量检索从该论文中匹配出的最相关片段，请严格基于这些片段回答细节问题；" +
            "若片段中不包含答案，请明确告知用户，严禁跨片段拼接或编造。" +
            (sanitizedBlocks > 0
              ? `\n（安全提示：本次共隔离 ${sanitizedBlocks} 个疑似指令注入文本块）`
              : ""),
          "",
        ];
        safeChunks.forEach((c, i) => {
          const sim = c.distance !== null ? `（距离 ${c.distance}，越小越相关）` : "";
          parts.push(`### 片段 ${i + 1}｜章节：${c.section}${sim}`, "", c.text, "---");
        });
        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: {
            ok: true,
            ref_id: "fulltext_1",
            title: params.paper_title,
            top_k: safeChunks.length,
            sanitizedBlocks,
            source: "pdf_vector",
          },
        };
      }

      // 失败/无命中：明确告知模型不可编造，只能如实报告。
      const content =
        `无法从论文（${params.paper_title}）获取与问题相关的片段：${outcome.reason ?? "未知错误"}。` +
        "请明确告知用户，禁止跨片段拼接或编造细节。";
      return {
        content: [{ type: "text", text: content }],
        details: { ok: false, reason: outcome.reason ?? null, title: params.paper_title },
      };
    },
  });

  // -------------------------------------------------------------------
  // 自定义工具：web_search（第十二阶段 · Mock，用于意图路由测试）
  //
  // 【多工具路由提升泛化能力的原理】
  //   把“不同性质的任务”分发给“各自专精的工具”，比让单一检索器包打天下更优：
  //     - 时间敏感问题（最新新闻/动态）若走学术检索，命中的是期刊论文而非新闻源；
  //     - 编程/数据处理若让检索工具做，属于功能错配。
  //   意图路由把“用户要什么”映射到“哪个工具最胜任”，各工具只保一份小职责，
  //   系统整体可用性与准确率随之提升。本工具为 Mock：返回结果含“模拟”标识，
  //   防止模型把占位内容当作真实新闻。
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "web_search",
    label: "Web Search (Mock)",
    description:
      "模拟搜索最新新闻/研究动态（时间敏感类问题专用）。当前为 Mock 实现，" +
      "返回的均为示例条目，不可作为真实事实引用。",
    parameters: Type.Object({
      query: Type.String({ description: "要检索的最新新闻/动态主题" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const mockItems = [
        {
          title: `（模拟）关于「${params.query}」的今日快讯 A`,
          source: "Mock News",
          date: new Date().toISOString().slice(0, 10),
          summary: "示例摘要：此为 web_search 路由测试占位内容，请勿当真。",
        },
        {
          title: `（模拟）关于「${params.query}」的今日快讯 B`,
          source: "Mock Daily",
          date: new Date().toISOString().slice(0, 10),
          summary: "示例摘要：此条同样为占位内容，不可用于学术引用。",
        },
      ];
      return {
        content: [
          {
            type: "text",
            text: `[web_search Mock 结果（占位，请勿当真）]\n${JSON.stringify(mockItems, null, 2)}`,
          },
        ],
        details: { mock: true, count: mockItems.length },
      };
    },
  });

  // -------------------------------------------------------------------
  // 自定义工具：code_interpreter（第十二阶段 · Mock）
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "code_interpreter",
    label: "Code Interpreter (Mock)",
    description:
      "模拟执行 Python/数据处理代码。当前为 Mock 实现，不会真实运行代码，" +
      "仅返回占位输出以验证意图路由。",
    parameters: Type.Object({
      code: Type.String({ description: "用户希望执行的代码（Mock 下不会真正运行）" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const snippet = params.code.slice(0, 200);
      return {
        content: [
          {
            type: "text",
            text:
              "[code_interpreter Mock] 已接收代码（未真实执行）：\n" +
              `\`\`\`\n${snippet}${params.code.length > 200 ? "\n...(截断)" : ""}\n\`\`\`` +
              "\n\n输出：print('(Mock) 数据处理成功，返回示例统计表')——占位内容，请勿当真。",
          },
        ],
        details: { mock: true, codeChars: params.code.length },
      };
    },
  });

  // -------------------------------------------------------------------
  // 自定义工具：user_memory —— 双层记忆的“长期层”（第十二阶段）
  //
  // 【双层记忆架构】
  //   短期记忆 = 会话内上下文（Pi 原生维护，无需我们实现）；
  //   长期记忆 = 跨会话持久化的用户画像/研究方向（本工具负责读写，落盘到
  //   data/memory.json）。模型在新对话开始时调用 load 恢复用户偏好，
  //   从而让检索/路由在第二次及以后的会话里“记得用户是谁”。
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "user_memory",
    label: "User Memory",
    description:
      "管理长期记忆：action=save 记录用户研究方向/偏好（跨会话持久化）；" +
      "action=load 在新对话开始时读取既往记忆。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("save"), Type.Literal("load")], {
        description: "save=记录一条记忆；load=读取全部记忆",
      }),
      content: Type.Optional(
        Type.String({ description: "save 时必填：要记住的用户研究方向或偏好" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.action === "load") {
        const entries = loadMemory();
        const body =
          entries.length === 0
            ? "（暂无长期记忆）"
            : entries.map((e) => `- [${e.timestamp}] ${e.content}`).join("\n");
        return {
          content: [{ type: "text", text: `[长期记忆]\n${body}` }],
          details: { action: "load", count: entries.length },
        };
      }
      // action === save
      const content = (params.content ?? "").trim();
      if (!content) {
        return {
          content: [{ type: "text", text: "保存失败：content 不能为空，请提供要记录的研究方向/偏好。" }],
          details: { action: "save", ok: false },
        };
      }
      const res = saveMemory(content);
      if (res.ok) {
        return {
          content: [
            { type: "text", text: `已保存到长期记忆（当前共 ${res.total} 条）：${content}` },
          ],
          details: { action: "save", ok: true, total: res.total },
        };
      }
      return {
        content: [{ type: "text", text: `保存失败：${res.reason ?? "未知错误"}` }],
        details: { action: "save", ok: false },
      };
    },
  });

  // -------------------------------------------------------------------
  // 事件四：message_update —— 后置校验与反思闭环（最终阶段核心）
  //
  // 【为什么选 message_update】
  //   它是"模型输出流"事件：assistant 每吐出新的内容块都会触发，携带当前
  //   累积的消息（event.message），因此能在正文形成的第一时间发现引用。
  //   （tool_result 描述的是工具执行结果而非模型陈述，不适合做输出校验。）
  //
  // 【AI 安全原理：后置校验（Post-hoc Verification）】
  //   第二阶段的提示词注入属于"事前防御"：它只能提高模型遵守约束的概率，
  //   无法 100% 阻止幻觉。后置校验不信任模型的自觉 —— 对实际产出的正文做
  //   确定性规则复查：抽取候选引文标识 → 与会话内已检索引用集比对 → 判定真伪。
  //   规则是确定的，因此能兜住事前提示挡不住的漏网引用（纵深防御）。
  //
  // 【AI 安全原理：反思闭环（Reflection Loop）】
  //   单纯告警只是"展示给用户看"，模型自己并不知道错在哪里。本处理器把
  //   校验结论（error_feedback）以消息形式注入当前对话上下文 ——
  //   deliverAs:"steer" 表示在本轮工具执行完毕后、下一次 LLM 调用前送达，
  //   相当于给模型一次"看到自己的错误并重写"的机会：让错误成为上下文的一部分，
  //   由模型在闭环中自我修正，而不只是停留在一次性的展示层。
  // -------------------------------------------------------------------
  pi.on("message_update", async (event, ctx) => {
    const msg = event.message as { role?: string; content?: unknown; id?: string };

    // 第 1 步：只检查 assistant 的可见正文（thinking / toolCall 块已在提取时排除）。
    const text = extractVisibleText(msg);
    if (text.length === 0) return;

    // 第 2 步：增量扫描。流式输出每次只"新增"一小段文本，若每次都全文重扫，
    // 同一引用会在每个 chunk 被重复报告。因此记录已扫描长度、只检查增量区，
    // 并保留 64 字符重叠窗口，防止一个引用恰好被切在两次更新的边界上。
    const key = msg.id ?? "assistant-stream";
    let state = scanStates.get(key);
    if (!state || text.length < state.scannedUpTo) {
      // 新消息，或文本回绕（说明进入了另一条 assistant 消息）→ 重置游标。
      scanStates.set(key, (state = { scannedUpTo: 0, reported: new Set<string>() }));
      if (scanStates.size > 200) scanStates.clear(); // 防止 Map 无限增长
    }
    const delta = text.slice(Math.max(0, state.scannedUpTo - 64));
    state.scannedUpTo = text.length;

    // 第 3 步：抽取增量中的候选引用，剔除“本消息已报告过”与“会话内真实检索”
    // 的 ID，余下即为幻觉引用（命中 VerificationResult 的失败分支）。
    const invalidIds = extractCandidateRefIds(delta).filter(
      (id) => !state.reported.has(id) && !retrievedRefIds.has(id),
    );
    invalidIds.forEach((id) => state.reported.add(id));
    if (invalidIds.length === 0) return;

    // 第 4 步：逐条生成 VerificationResult（is_valid=false）并累计纠错轮数。
    const results: VerificationResult[] = [];
    const citationFeedback: string[] = [];
    for (const id of invalidIds) {
      const verification: VerificationResult = {
        is_valid: false,
        error_feedback: `引用 [${id}] 在文献中不存在，请重新核实或删除该引用。`,
      };
      results.push(verification); // 统一收集校验结论（后续阶段可落审计日志）
      const round = (correctionCounts.get(id) ?? 0) + 1;
      correctionCounts.set(id, round);
      if (round <= MAX_CORRECTION_ROUNDS) {
        citationFeedback.push(verification.error_feedback);
      } else {
        // 已多次提示仍未修正：停止自动干预，避免无限“修正循环”烧 token。
        console.log(
          `[ScholarGuardian] 引用 [${id}] 已自动纠错 ${round - 1} 轮仍未修正，停止干预。`,
        );
      }
    }
    if (results.length === 0) return; // 理论不可达：任一信号触发都会入列结论

    // 第 5 步：用户可见告警（仅在本轮首次出现该引用时触发一次）。
    if (citationFeedback.length > 0) {
      ctx.ui.notify(
        `[ScholarGuardian] 检测到疑似幻觉引用：\n${citationFeedback
          .map((f) => `- ${f}`)
          .join("\n")}`,
        "error",
      );
    }

    // 第 6 步：把 error_feedback 注入对话上下文，触发模型自我修正（反思闭环）。
    if (citationFeedback.length > 0) {
      const correction = buildCorrectionMessage(citationFeedback);
      try {
        pi.sendUserMessage(correction, { deliverAs: "steer" });
      } catch {
        // 非流式 / 无界面等场景可能无法按 steer 排队 → 退回 followUp；
        // 仍失败则仅保留用户侧告警，不阻塞正常对话。
        try {
          pi.sendUserMessage(correction, { deliverAs: "followUp" });
        } catch (err) {
          console.warn("[ScholarGuardian] 自我修正消息入队失败：", err);
        }
      }
    }
  });
}
