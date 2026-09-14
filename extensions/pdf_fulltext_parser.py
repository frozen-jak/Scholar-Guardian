#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ScholarGuardian —— PDF 全文解析工具（Python 侧，单一职责）

职责：接收一个本地 PDF 路径，提取全部页面的纯文本，
     仅保留前 FULLTEXT_TRUNCATE_CHARS（8000）个字符后输出到 stdout。
     —— 8000 字符通常足以覆盖摘要、引言与核心方法部分，
        同时把喂给大模型的上下文体积控制在合理范围。

环境自适应（Auto-Fix）：
    脚本最顶层先尝试导入 PyMuPDF（fitz）；若缺失，自动调用当前解释器的
    pip 安装 PyMuPDF 后再导入，避免“装了别的解释器”导致的环境隔离问题。
    注意：安装进度信息一律写到 stderr —— stdout 是正文数据通道，
    不能被任何日志污染（TS 侧以 stdout 为唯一解析数据源）。

异常约定（进程退出码）：
    0  成功（文本已写入 stdout）
    1  文件不存在 / 不是文件
    2  缺少命令行参数
    3  缺少/自动安装失败（PyMuPDF 不可用）
    4  PDF 能打开但未提取到任何文本（扫描件 / 图片型 PDF）
    5  其他解析异常
错误信息一律写入 stderr（不污染 stdout 的数据通道）。
"""

import os
import subprocess
import sys

# 与 scholar-guardian.ts 中的 FULLTEXT_TRUNCATE_CHARS 保持一致的截断上限。
FULLTEXT_TRUNCATE_CHARS = 8000


def _pick_venv_python():
    """
    定位脚本同目录下 pymupdf_env 虚拟环境中的解释器。

    背景（PEP 668 / externally-managed-environment）：
      Debian/Ubuntu 23.04+ 的系统 Python 被标记为 externally-managed，
      直接 `pip install` 到系统环境会报错
      “error: externally-managed-environment”，提示改用 venv/uv 等。
      因此需要为依赖（PyMuPDF）建立独立虚拟环境 pymupdf_env，
      并让脚本自动优先使用其中的解释器。

    兼容两种 venv 目录布局：
      - Linux/macOS：pymupdf_env 下 bin/python
      - Windows    ：pymupdf_env 下 Scripts 目录的 python.exe
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "pymupdf_env", "bin", "python"),  # POSIX 布局
        os.path.join(script_dir, "pymupdf_env", "Scripts", "python.exe"),  # Windows 布局
    ]
    return next((p for p in candidates if os.path.isfile(p)), None)


def _exec_under_venv():
    """
    若检测到 pymupdf_env 虚拟环境且当前解释器不是它，则用该解释器
    重新执行本脚本（os.execv 替换当前进程，此后不会再返回）。

    这样后续的 import fitz 与“缺失时自动安装”都会发生在虚拟环境内：
      - 避开 PEP 668 对系统 Python 的限制；
      - 与 Node 侧 execSync 调用的解释器（可能仍是系统 python）解耦。
    已在该虚拟环境内运行时（sys.executable 与 venv 解释器一致）直接跳过，
    避免 execv 自我循环。
    """
    venv_python = _pick_venv_python()
    if not venv_python:
        return
    if os.path.realpath(sys.executable) == os.path.realpath(venv_python):
        return
    print(
        f"[ScholarGuardian] 检测到虚拟环境解释器：{venv_python}，切换执行。",
        file=sys.stderr,
    )
    os.execv(venv_python, [venv_python] + sys.argv)


def ensure_fitz():
    """
    确保 PyMuPDF 可用：缺失时自动安装（Auto-Fix）。

    设计理由：TS 侧用 execSync 调用的解释器取决于 pi 进程的 PATH 环境，
    可能与用户手工在 CMD 里 `pip install` 所装的 Python 不是同一个
    （环境隔离的常见根因）。因此用 *同一个* sys.executable 去安装，
    保证“谁运行脚本、就用谁的 pip”，彻底消除解释器错位问题。
    """
    try:
        return __import__("fitz")  # 已安装 → 直接返回模块
    except ImportError:
        print(
            "[ScholarGuardian] 检测到缺失 PyMuPDF，正在自动安装...",
            file=sys.stderr,  # 日志走 stderr，不污染 stdout 正文通道
        )
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet", "PyMuPDF"],
            )
        except Exception as exc:
            print(f"[错误] PyMuPDF 自动安装失败：{exc}", file=sys.stderr)
            print("请手动执行: python -m pip install PyMuPDF", file=sys.stderr)
            sys.exit(3)
        try:
            return __import__("fitz")
        except ImportError as exc:
            print(f"[错误] 自动安装后仍无法导入 PyMuPDF：{exc}", file=sys.stderr)
            sys.exit(3)


def extract_text(pdf_path: str) -> str:
    """遍历所有页面提取纯文本；累计达到截断上限即提前停止（省时省内存）。"""
    import fitz  # PyMuPDF：PDF 渲染/文本层还原能力成熟，是选型 Python 的核心原因

    doc = fitz.open(pdf_path)
    try:
        parts: list[str] = []
        total = 0
        for page in doc:
            page_text = page.get_text()
            parts.append(page_text)
            total += len(page_text)
            if total >= FULLTEXT_TRUNCATE_CHARS:
                break
        return "".join(parts)[:FULLTEXT_TRUNCATE_CHARS]
    finally:
        doc.close()


def main() -> None:
    # 环境自适应（第一步）：优先切换到同目录虚拟环境解释器，再执行后续逻辑。
    _exec_under_venv()

    if len(sys.argv) < 2:
        print("用法: python pdf_fulltext_parser.py <pdf_path>", file=sys.stderr)
        sys.exit(2)

    pdf_path = sys.argv[1]
    if not os.path.isfile(pdf_path):
        print(f"[错误] 文件不存在: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    # 环境自适应：先确保 PyMuPDF 可用（缺失则自动安装），失败以退出码 3 结束。
    ensure_fitz()

    try:
        text = extract_text(pdf_path)
    except Exception as exc:  # 解析失败（文件损坏 / 加密等）统一走 stderr
        print(f"[错误] PDF 解析失败: {exc}", file=sys.stderr)
        sys.exit(5)

    if not text.strip():
        print("[错误] PDF 中未提取到任何文本（可能是扫描件或纯图片型 PDF）。", file=sys.stderr)
        sys.exit(4)

    # 纯文本写入 stdout —— TS 侧以此为唯一数据通道。
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
