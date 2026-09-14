#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ScholarGuardian —— 论文专属结构化切片工具（pdf_vectorizer.py）

【为什么论文不能按固定字符长度机械切分？】
   科研论文里充满了公式、表格、行内代码与连续的逻辑推导：
     - 固定长度硬切会拦腰切断公式（如 CaMKII 的 2+ 配体半衰期表述、LaTeX 记号）
       与表格单元格，破坏语义；
     - 公式/结论常跨行书写，若断点落在其内部，向量检索将永远召回"半截证据"。
   因此本模块采用 "结构化优先 + 递归兜底" 的两级切片策略，
   只在语义边界（章节/段落/句子/词）处断开。

切片参数（可调）：
   MIN_CHARS / MAX_CHARS : 目标块长 400~800 字符
   OVERLAP_CHARS         : 相邻块重叠 ~80 字符（约为块长的 10%~20%），
                           避免关键上下文恰好落在块边界而被检索漏掉。

输出：每块为 dict：
   { "text": "...", "metadata": { "section": 章节标题, "chunk_index": n,
                                    "char_start"/"char_end": 字符区间, "has_overlap": bool } }
   —— 章节标题随块入库，可显著提升检索精准度（块检索时能按 section 过滤/加权）。

用法：
   python pdf_vectorizer.py <已提取的纯文本文件>     # 输出 JSON 分块列表（stdout）
   python pdf_vectorizer.py                          # 打印内置演示用例（便于自测）
"""

import hashlib
import json
import os
import re
import subprocess
import sys

# ---------------------------------------------------------------- 可调参数
MIN_CHARS = 400        # 目标块长的下限
MAX_CHARS = 800        # 目标块长的上限（超过即触发兜底拆分）
OVERLAP_CHARS = 80     # 相邻块重叠字符数（约 10%~20%）
# 递归兜底的断点优先级：段落 → 行 → 中文句号 → 空格
FALLBACK_DELIMS = ["\n\n", "\n", "。", " "]
# 句子级边界字符（用于在重叠区/兜底时定位“安全切断点”）
SENTENCE_BOUNDARY = set("。．.!?；;，,：: ")

MARKDOWN_HEADING = re.compile(r"^#{1,6}\s+.+$")
# 论文常见章节标题启发式：编号标题 或 纯大写短行 或 "xxx:" 起头
NUMBERED_HEADING = re.compile(r"^\s*\d+(\.\d+)*[\s.、．]+\S")
UPPER_HEADING = re.compile(r"^[A-Z][A-Z\s\-&/()]{2,60}$")


def normalize_text(text: str) -> str:
    """规整提取文本：统一换行、去除表格等产生的孤行噪音（最小化处理）。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 去除只有单个可见字符的行（常为图表残留），避免干扰段落边界
    lines = [ln for ln in text.split("\n") if len(ln.strip()) > 1 or ln.strip() == ""]
    return "\n".join(lines)


def looks_like_heading(line: str) -> bool:
    """判断一行是否像章节标题（Markdown 标题 / 编号标题 / 短英文大写标题）。"""
    s = line.strip()
    if not s:
        return False
    if MARKDOWN_HEADING.match(s) or NUMBERED_HEADING.match(s):
        return True
    if len(s) <= 60 and (UPPER_HEADING.match(s) or s.endswith(":")):
        return True
    return False


def split_paragraphs(text: str):
    """
    第一级切分基础：按“自然段落”切。

    兼容两类输入：
      - 规范文本：段落间有空行（\n\n）——直接按空行分组；
      - PyMuPDF 原始输出：常为单 \n 的逐行文本——退化为按行成段，
        避免把整篇当成一个超长段落。
    """
    text = normalize_text(text)
    if "\n\n" in text:
        raw = text.split("\n\n")
    else:
        raw = text.split("\n")
    paras = []
    for part in raw:
        p = part.strip()
        if p:
            paras.append(p)
    return paras


def _safe_cut_index(text: str, max_chars: int, delims) -> int | None:
    """
    在不超过 max_chars 的前提下，寻找尽量靠右的语义边界下标。
    返回下标（切在边界“之后”，左片 rstrip / 右片 lstrip 交由调用方）。
    """
    best = None
    for d in delims:
        if d == " ":
            # 空格断点取在空格之后（切后右片不带头空格）
            i = text.rfind(" ", 0, max_chars + 1)
            if i >= 0:
                best = i if best is None else max(best, i)
            continue
        start = 0
        while True:
            i = text.find(d, start)
            if i == -1 or i > max_chars:
                break
            cut = i + len(d)  # 换行/句号等断点切在其后，保留完整语义
            best = cut if best is None else max(best, cut)
            start = i + 1
    return best


def split_oversized(text: str, delims=None, depth: int = 0):
    """
    第二级：递归兜底拆分（仅当单段超过 MAX_CHARS 时触发）。

    断点优先级：\n\n -> \n -> 。 -> 空格（逐级降级）。
    每次从“离起点最近但不超过 MAX_CHARS”的边界处切，左片递归直到
    长度达标；理论上深度受文本长度对数限制，且总有空格/硬切兜底，不会死循环。
    """
    if delims is None:
        delims = list(FALLBACK_DELIMS)
    if len(text) <= MAX_CHARS:
        return [text]

    idx = _safe_cut_index(text, MAX_CHARS, delims)
    if idx is None:
        if len(delims) > 1:
            # 降级到下一优先级的边界集合（例如 无空行 → 用句号）
            return split_oversized(text, delims[1:], depth + 1)
        # 终极兜底：在空格处切；若连空格都没有（如连续公式），
        # 退而求其次硬切 —— 但此时已不属于“正常论文文本”情形。
        idx = text.rfind(" ", 0, MAX_CHARS)
        if idx <= 0:
            idx = MAX_CHARS
    left = text[:idx].rstrip()
    right = text[idx:].lstrip()
    # 防御：左右完全没切开（异常）时强切，防止死循环
    if not left or not right or len(left) + len(right) >= len(text) + 2:
        return [text[:MAX_CHARS], text[MAX_CHARS:]]
    return split_oversized(left, delims, depth + 1) + split_oversized(right, delims, depth + 1)


def _paragraphs_to_base_chunks(paras, section: str):
    """
    用贪心算法把段落聚合成“基础块”（每个 ≤ MAX_CHARS）；
    超长段落先走 split_oversized 兜底，再把碎片参与聚合。
    """
    base: list[list[str]] = []
    cur: list[str] = []
    cur_len = 0

    def flush():
        nonlocal cur, cur_len
        if cur:
            base.append(cur)
            cur, cur_len = [], 0

    for para in paras:
        if len(para) > MAX_CHARS:
            flush()
            for piece in split_oversized(para):
                base.append([piece])
            continue
        if cur and cur_len + len(para) + 1 > MAX_CHARS:
            flush()
        cur.append(para)
        cur_len += len(para) + 1
    flush()
    return base


def take_overlap_prefix(prev_text: str, target: int = OVERLAP_CHARS) -> str:
    """
    取上一块的“尾部重叠”作为下一块前缀：尽量在句子/空格边界开始，
    避免前缀从单词中间切入。
    """
    if len(prev_text) <= target:
        return prev_text
    window_start = len(prev_text) - int(target * 1.5)
    if window_start < 0:
        window_start = 0
    # 在窗口内找最靠右的边界字符，取其后作为重叠起点
    cut = -1
    for i in range(len(prev_text) - 1, window_start - 1, -1):
        if prev_text[i] in SENTENCE_BOUNDARY:
            cut = i + 1
            break
    if cut == -1 or len(prev_text) - cut > target * 2:
        cut = max(window_start, len(prev_text) - target)
    return prev_text[cut:]


def apply_overlap(base_chunks: list) -> list:
    """在相邻基础块之间注入 ~OVERLAP_CHARS 的重叠前缀。"""
    out: list = []
    prev_text = ""
    for i, c in enumerate(base_chunks):
        text = "".join(c)  # 段落间以换行连接
        if i > 0 and prev_text:
            prefix = take_overlap_prefix(prev_text)
            text = (prefix.rstrip() + "\n" + text) if prefix else text
        out.append((i, text, bool(i > 0)))
        prev_text = text
    return out


def chunk_text(text: str) -> list:
    """
    主入口：纯文本 → 带章节元数据的切片列表。

    流程：
      1) 解析章节：以“疑似标题行”为界，把文档切成 (section, body)；
      2) 每个章节内：段落聚合 + 超长兜底 → 基础块；
      3) 相邻基础块注入重叠前缀；
      4) 生成 metadata（section、chunk_index、字符区间、has_overlap）。
    """
    text = normalize_text(text)
    paras = split_paragraphs(text)

    # —— 1) 章节化：维护当前章节标题 ——
    sections: list[list[str]] = []   # 元素: (section_title, [paras])
    cur_title = "root"  # 未识别章节时使用
    cur_body: list[str] = []
    for p in paras:
        # 标题行作为新章节起点（标题本身也保留进正文，便于模型看到上下文）
        if looks_like_heading(p.split("\n")[0]):
            sections.append([cur_title, cur_body])
            cur_title = re.sub(r"^#{1,6}\s*", "", p)[:120]
            cur_body = [p]
        else:
            cur_body.append(p)
    sections.append([cur_title, cur_body])

    result: list[dict] = []
    global_index = 0
    for title, body in sections:
        if not body:
            continue
        base = _paragraphs_to_base_chunks(body, title)
        overlapped = apply_overlap(base)
        for chunk_index, ctext, has_overlap in overlapped:
            result.append(
                {
                    "text": ctext,
                    "metadata": {
                        "section": title,
                        "chunk_index": global_index,
                        "has_overlap": has_overlap,
                        "chars": len(ctext),
                    },
                }
            )
            global_index += 1
    return result


# ------------------------------------------------------------------ CLI
_DEMO = (
    "# Introduction\n\n"
    "蛋白质-配体结合自由能的计算是现代药物发现的核心问题之一。\n\n"
    "## Methods\n\n"
    "我们采用基于扩散模型的统一架构进行预测。该模型接收加噪的原子坐标并预测真实坐标，"
    "训练目标为加权组合的多个损失项，包括坐标直方图交叉熵、原子级置信度以及配体内部的几何约束。"
    "模型在训练时不使用扭转参数化，也不引入结构违反损失。"
    "这一设计使得模型能够处理包含蛋白质、核酸、小分子、离子在内的多种复合物体系。\n\n"
    "其中，小分子配体以原子图形式输入，每个原子携带元素类型、杂化状态与形式电荷等特征，"
    "键级信息则通过邻接关系编码。扩散模块在推理阶段进行 20 次迭代去噪，并采样 48 个候选结构，"
    "最终通过置信度模块选择最可信的结构输出。\n\n"
    "## Results\n\n"
    "在 PoseBusters 基准上的实验表明，所提方法在蛋白-配体对接任务上显著优于传统对接软件。"
    "对 21 个立方对称体系的组装预测中位 TM-score 达到 0.99。\n\n"
)


# =====================================================================
# ChromaDB 向量化检索（第十一阶段）
# =====================================================================
# 原理说明（RAG 向量层）：
#   关键词/正则检索是“字面匹配”，而用户的疑问与论文原文常用不同措辞表达
#   同一含义。Embedding 模型把文本映射到高维语义空间，使“意思相近但字面
#   不同”的片段距离很近 —— 检索从“找字眼”升级为“找语义”。
#   ChromaDB 负责向量存储与近似近邻搜索（ANN，默认 HNSW），支持磁盘持久化，
#   论文只需 embed 一次，后续查询复用索引，避免重复计算。

# ChromaDB 持久化目录：脚本同目录 data/chroma_db（相对路径、跨平台兼容）
CHROMA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "chroma_db")
COLLECTION_NAME = "scholar_guardian"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


# ---------------------------------------------------------------- 自动安装
def auto_install(module_name: str, pip_name: str) -> None:
    """
    依赖自动安装（Auto-Fix）：缺失时用当前解释器的 pip 静默安装后重试导入。
    说明：全部日志走 stderr，stdout 仅承载检索/索引结果 JSON。
    """
    try:
        __import__(module_name)
    except ImportError:
        print(
            f"[ScholarGuardian] 检测到缺少依赖 {pip_name}，正在自动安装（首次较慢）...",
            file=sys.stderr,
        )
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", pip_name])
        __import__(module_name)


# ------------------------------------------------------------ Embedding 模型
_embedder = None


def get_embedder():
    """懒加载本地 Embedding 模型（首次调用时加载；模型无需联网、轻量高效）。"""
    global _embedder
    if _embedder is None:
        auto_install("sentence_transformers", "sentence-transformers")
        from sentence_transformers import SentenceTransformer

        _embedder = SentenceTransformer(EMBEDDING_MODEL)
    return _embedder


def get_collection():
    """懒建立 ChromaDB 持久化客户端与集合（HNSW + 余弦相似度）。"""
    auto_install("chromadb", "chromadb")
    import chromadb

    client = chromadb.PersistentClient(path=CHROMA_DIR)
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


def _paper_id(pdf_path: str, title: str) -> str:
    """由文件内容+标题生成稳定 paper_id，重复索引同论文时覆盖更新。"""
    h = hashlib.sha256()
    try:
        with open(pdf_path, "rb") as f:
            h.update(f.read(1 << 20))  # 仅取前 1MB 作指纹，足够区分且够快
    except OSError:
        pass
    h.update(title.encode("utf-8", "ignore"))
    return f"paper_{h.hexdigest()[:16]}"


def _extract_all_text(pdf_path: str) -> str:
    """用 PyMuPDF 抽取全文字文本（向量索引需要全文，不做 8000 截断）。"""
    auto_install("fitz", "PyMuPDF")
    import fitz

    doc = fitz.open(pdf_path)
    try:
        return "\n\n".join(page.get_text() for page in doc)
    finally:
        doc.close()


def index_paper(pdf_path: str, title: str) -> dict:
    """
    index_paper：解析 PDF → 结构化切片 → Embedding → 持久化进 ChromaDB。
    相同 paper_id 再次索引时覆盖旧分块（避免重复堆积）。
    """
    auto_install("chromadb", "chromadb")
    raw = _extract_all_text(pdf_path)
    chunks = chunk_text(raw)  # 复用第一阶段结构化切片（含章节元数据）
    pid = _paper_id(pdf_path, title)
    collection = get_collection()

    # 覆盖旧索引：先删除该 paper_id 名下旧块
    existing = collection.get(where={"paper_id": pid}, include=[])
    if existing.get("ids"):
        collection.delete(ids=existing["ids"])

    ids: list[str] = []
    docs: list[str] = []
    metas: list[dict] = []
    for c in chunks:
        cid = f"{pid}:{c['metadata']['chunk_index']}"
        ids.append(cid)
        docs.append(c["text"])
        m = dict(c["metadata"])
        m["paper_id"] = pid
        m["title"] = title
        metas.append(m)
    if docs:
        collection.add(ids=ids, documents=docs, metadatas=metas)
    return {"ok": True, "paper_id": pid, "indexed_chunks": len(docs), "chroma_dir": CHROMA_DIR}


def search_paper(query: str, top_k: int = 3) -> dict:
    """
    search_paper：查询向量化 → 余弦近邻检索 → 返回 Top-K 片段及其章节元数据。
    检索结果含距离（distance，越小越相似），供上层排序/阈值使用。
    """
    embedder = get_embedder()
    collection = get_collection()
    emb = embedder.encode([query]).tolist()
    res = collection.query(query_embeddings=emb, n_results=max(1, int(top_k)))
    results = []
    ids0 = res.get("ids", [[]])[0]
    docs0 = res.get("documents", [[]])[0]
    metas0 = res.get("metadatas", [[]])[0]
    dists0 = res.get("distances", [[]])[0]
    for i in range(len(ids0)):
        m = metas0[i] if i < len(metas0) else {}
        results.append(
            {
                "text": docs0[i],
                "section": (m or {}).get("section", "未知章节"),
                "title": (m or {}).get("title", ""),
                "chunk_index": (m or {}).get("chunk_index", -1),
                "distance": round(float(dists0[i]), 4) if i < len(dists0) else None,
            }
        )
    return {"ok": True, "query": query, "results": results}


def main() -> None:
    # —— ChromaDB 子命令模式（第十一阶段） ——
    if len(sys.argv) >= 2 and sys.argv[1] in ("index", "search"):
        cmd = sys.argv[1]
        try:
            if cmd == "index":
                if len(sys.argv) < 3:
                    raise SystemExit("用法: python pdf_vectorizer.py index <pdf路径> [标题]")
                out = index_paper(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else os.path.basename(sys.argv[2]))
            else:
                if len(sys.argv) < 3:
                    raise SystemExit("用法: python pdf_vectorizer.py search <查询> [top_k]")
                out = search_paper(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 3)
            print(json.dumps(out, ensure_ascii=False))
            return
        except Exception as exc:  # 依赖/索引/检索失败统一走 stderr + 退出码 1
            print(f"[错误] {cmd} 失败: {exc}", file=sys.stderr)
            sys.exit(1)

    # —— 旧版纯文本分块模式（保持兼容，用于无向量环境） ——
    if len(sys.argv) < 2:
        print("用法: python pdf_vectorizer.py <纯文本文件>  （无参则运行内置演示）", file=sys.stderr)
        text = _DEMO
    else:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            text = f.read()

    chunks = chunk_text(text)
    for c in chunks:
        print(json.dumps(c, ensure_ascii=False))
    print(
        f"\n# 统计: 共 {len(chunks)} 块 | "
        f"平均长度 {sum(c['metadata']['chars'] for c in chunks) // max(len(chunks), 1)} 字符 | "
        f"含重叠的块 {sum(1 for c in chunks if c['metadata']['has_overlap'])}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
