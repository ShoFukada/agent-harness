#!/usr/bin/env python3
"""人が読む日本語の最終仕上げを Gemini 4 Neon に通す。

  polish.py <file>            仕上げた本文を stdout に出す（元ファイルは書き換えない）
  polish.py --diff <file>     元テキストとの unified diff を出す
  polish.py                   stdin から読む
  polish.py --audience client <file>   顧客・社外の業務文書として、口語を業務文書の語に直させる
  polish.py --doc-type proposal <file> 文書の種類（yomiyasu の 13 種類）の規則を足す

規則は ja-review hook と同じものを渡す（同じディレクトリの SKILL.md の「書き方の規則」節と、
yomiyasu の基本原則・文書の種類・顧客向けなら書き手と読み手）。読めない規則は stderr に断ってから外す。
仕上げた後に yomiyasu_diff で許可・義務の言い方、文の種類、数値の変化と、原文に無い人や担当の追加を探し、
見つかれば stderr に種類を出す（本文は出す。採るかは差分を見て決める）。

本文は argv ではなく stdin の stream-json で agy に渡す（`agy -p` は stdin を読まないので、長い
本文で argv が溢れるのを避けるにはこの経路しかない）。agy は claude/bin/agy_launch.py から起動し、
cwd は呼び出しごとの使い捨ての空ディレクトリにして project 設定を読ませず、環境変数を許可リストで絞る。
本文に仕込まれた指示に従わないよう、agy には --sandbox と、コマンド・書き込み・ファイルと URL の読み取り・MCP を
拒否する settings を渡す（agy_launch.text_only_args）。worker の sandbox の中からは claude/bin/neon-polish で呼ぶ。
失敗したときは stdout に何も出さず、stderr に理由を書いて非 0 で終わる。
"""

import argparse
import difflib
import importlib.util
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "bin"))
import agy_launch  # noqa: E402

MODEL = "gemini-4-neon-high"
PRINT_TIMEOUT = "4m"
KILL_AFTER = 300
MAX_CHARS = 200000
HOOKS_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "hooks")

FENCE_RE = re.compile(r"\A```[^\n]*\n(.*)\n```\Z", re.S)
STRUCTURAL = ("#", "-", "*", ">", "|", "`", "+", "1.")
PREAMBLE_RE = re.compile(
    r"\A(?:以下|こちら|下記)[^\n]{0,60}\Z"
    r"|\A[^\n]{0,60}(?:仕上げ|修正|校正|整え|清書|推敲|直し)まし[^\n]{0,20}\Z")

PROMPT = """あなたは日本語の仕上げ役です。渡された文章の語彙と文の自然さだけを整えてください。

変えないもの: 内容・主張・構成・段落の順序・箇条書きの数・敬体と常体・引用・コード・識別子・URL・数値・固有名詞。Markdown の構造（見出し・箇条書き・表・コードブロック）はそのまま保ってください。
整えるもの: 英語の直訳調な言い回し、一度読んで意味の取れない長い文、硬すぎる語彙。業界で普通に使う用語は言い換えない。
%s
%s
出力は仕上げた本文だけにしてください。前置き・説明・変更点の一覧・全体を囲むコードフェンスを付けないでください。

--- 対象 ---
%s
"""


def _load_review():
    # 読み手の印と語調の指示は仕上げの hook と同じものを使う（2 か所で判定がずれないように）
    path = os.path.join(HOOKS_DIR, "ja-review.py")
    spec = importlib.util.spec_from_file_location("ja_review", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_REVIEW = _load_review()


def build_prompt(text, audience=None, doc_type=None):
    """(agy に渡すプロンプト, 規則を同梱できなかった理由。すべて同梱できたら None)"""
    aud = audience or _REVIEW.audience(text)
    block, problems = _REVIEW.prompt_rules(aud, doc_type or _REVIEW.ja_yomiyasu.detect_doc_type(text))
    return PROMPT % (_REVIEW.TONE[aud], block, text), "、".join(problems) or None


def parse_agy(returncode, output):
    """stream-json の result 行から応答の本文を取り出す。取り出せなければ None。"""
    if returncode != 0:
        return None
    for line in reversed((output or "").splitlines()):
        try:
            event = json.loads(line.strip() or "null")
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get("event") != "result":
            continue
        result = event.get("result")
        if not isinstance(result, dict) or result.get("status") != "SUCCESS":
            return None
        response = result.get("response")
        return response if isinstance(response, str) else None
    return None


def strip_wrapping(response):
    """本文全体を包むコードフェンスと、本文の前に付いた 1 行の前置きを外す。"""
    text = response.strip("\n")
    fenced = FENCE_RE.match(text)
    if fenced:
        text = fenced.group(1)
    lines = text.split("\n")
    body = [line for line in lines[1:] if line.strip()]
    if len(body) >= 2 and not lines[0].startswith(STRUCTURAL) and PREAMBLE_RE.match(lines[0]):
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines = lines[1:]
        text = "\n".join(lines)
    return text


def polish(prompt, model):
    """仕上げた本文。失敗したときは None。"""
    line = json.dumps({"event": "user", "message": {
        "role": "user", "content": [{"type": "text", "text": prompt}]}}) + "\n"
    try:
        done = agy_launch.run(
            ["agy", *agy_launch.text_only_args(), "--model", model,
             "--input-format", "stream-json", "--output-format", "stream-json",
             "--print-timeout", PRINT_TIMEOUT, "--disable-slash-commands"],
            input=line, timeout=KILL_AFTER, prefix="ja-polish-")
    except (OSError, subprocess.SubprocessError):
        return None
    response = parse_agy(done.returncode, done.stdout)
    if response is None or not response.strip():
        return None
    return strip_wrapping(response)


def ends_with_newline(text):
    return text if text.endswith("\n") else text + "\n"


def diff(original, polished, name):
    return "".join(difflib.unified_diff(
        ends_with_newline(original).splitlines(True),
        ends_with_newline(polished).splitlines(True),
        fromfile=name, tofile=name + "（仕上げ後）"))


def main(argv):
    parser = argparse.ArgumentParser(description="人が読む日本語の最終仕上げ")
    parser.add_argument("file", nargs="?", help="仕上げる文章のファイル（省略時は stdin）")
    parser.add_argument("--diff", action="store_true", help="元テキストとの unified diff を出す")
    parser.add_argument("--model", default=MODEL, help="agy に渡すモデル（既定: %s）" % MODEL)
    parser.add_argument("--audience", choices=("client", "internal"),
                        help="読み手（client は顧客・社外の業務文書）。省略時は本文の印か中身で判断させる")
    parser.add_argument("--doc-type", choices=_REVIEW.ja_yomiyasu.DOC_TYPES,
                        help="文書の種類。省略時は本文の doc-type: の印かファイル名で決め、決まらなければ渡さない")
    args = parser.parse_args(argv)

    if args.file:
        try:
            with open(args.file, encoding="utf-8") as fh:
                text = fh.read()
        except OSError as error:
            sys.stderr.write("読めない: %s\n" % error)
            return 1
    else:
        text = sys.stdin.read()
    return run(text, args.file, args.diff, args.audience, args.doc_type, args.model)


def run(text, name, show_diff=False, audience=None, doc_type=None, model=MODEL):
    """読み終えた本文を仕上げて stdout に出し、終了コードを返す。name はファイル名（文書の種類の判定と diff の見出し）。
    claude/bin/neon-polish もここを呼ぶ（worker の sandbox の外で、本文を自分で読んでから渡す）。"""
    if not text.strip():
        sys.stderr.write("入力が空\n")
        return 1
    if len(text) > MAX_CHARS:
        sys.stderr.write("入力が長すぎる（%d 字、上限 %d 字）。章ごとに分けて渡す\n"
                         % (len(text), MAX_CHARS))
        return 1

    doc_type = doc_type or _REVIEW.ja_yomiyasu.detect_doc_type(text, name)
    prompt, problem = build_prompt(text, audience, doc_type)
    if problem:
        sys.stderr.write("規則を同梱できなかった（%s）。読めた規則だけで仕上げる\n" % problem)
    polished = polish(prompt, model)
    if polished is None:
        sys.stderr.write("agy の呼び出しに失敗した（未実行・timeout・認証切れのいずれか）\n")
        return 1
    risks = _REVIEW.ja_yomiyasu.meaning_risks(text, polished, doc_type)
    if risks:
        sys.stderr.write("yomiyasu_diff が意味の変わる恐れを見つけた: %s。差分で確かめる\n"
                         % ", ".join(sorted(set(risks))))
    if show_diff:
        sys.stdout.write(diff(text, polished, name or "stdin"))
    else:
        sys.stdout.write(ends_with_newline(polished))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
