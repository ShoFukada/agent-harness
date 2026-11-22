"""日本語と英数字の間の半角の空白を、詰めてよい所だけ詰める（判断の記録 R85・R88）。

詰めるのは、日本語の文字と、空白を挟まない 1 つの短い英数字の語（3・22:00・main・ID・Neon）の間の空白。
次は残す:
- 英数字どうしの間の空白（「commit 1」「Claude Code」）。語の切れ目が消えるため
- コード・URL・HTML のタグ・リンク先に接する空白。インラインコード（複数行も）・フェンスとインデントの
  コードブロック（引用の中も）・pre/code/script/style・frontmatter の中は見ない
- パス・ファイル名・SHA・ブランチ名・オプション・識別子らしい語（/ _ * @ = などを含む語、拡張子付きの語、
  英字を - でつないだ語、7 字以上の 16 進数）と、日本語の側がファイル名かパスの所（「git add 報告.md」）。
  区切りが見えなくなると読み違えるため
- Markdown の番号付きリストの印（「1. 」「1) 」）と、英語の文の区切り（「Note: 」）
"""

import bisect
import re

JA = re.compile(r"[ぁ-ゖァ-ヺー一-龯々〆ヵヶ]")
SPACES = re.compile(r" +")
# 詰めてよい語の形。括弧で始まる・終わるのは「(3 件)」「[Neon が見る](…)」のような囲みの端
TOKEN = re.compile(r"[(\[]?#?[A-Za-z0-9](?:[A-Za-z0-9.,:+#%&'-]*[A-Za-z0-9+#%])?[)\]]?")
FILE_NAME = re.compile(r".*[A-Za-z0-9]\.[A-Za-z][A-Za-z0-9]{0,4}")
SHA = re.compile(r"(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}")
HYPHENATED = re.compile(r"[A-Za-z]-[A-Za-z0-9]|[A-Za-z0-9]-[A-Za-z]")
PATH_LIKE = re.compile(r"[/\\_]|\.[A-Za-z]")
JA_STOP = "、。，．（）「」『』【】・：；！？"

FRONTMATTER = re.compile(r"\A\ufeff?---[ \t]*\r?\n.*?^---[ \t]*\r?$", re.S | re.M)
FENCE = re.compile(r"^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})")
INDENTED = re.compile(r"^(?: {4}|\t)")
QUOTE = re.compile(r"^(?:[ \t]{0,3}>[ \t]?)*")
LIST_ITEM = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]")
RAW_HTML = re.compile(r"<(pre|code|script|style|textarea)\b[^>]*>.*?</\1\s*>", re.S | re.I)
PROTECTED = (
    re.compile(r"<!--.*?-->", re.S),
    re.compile(r"(`+)(?:(?!\n[ \t]*\r?\n).)*?\1", re.S),
    re.compile(r"</?[A-Za-z!][^>\n]*>"),
    re.compile(r"\]\([^)\n]*\)"),
    re.compile(r"^ {0,3}\[[^\]\n]+\]:[^\n]*", re.M),
    re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+"),
)


def _fenced(text, mask):
    """フェンスのコードブロックと、空行の後から始まるインデントのコードブロックの位置を 1 にする。"""
    pos = 0
    opening = None
    previous_blank = True
    indented = False
    in_list = False
    for line in text.split("\n"):
        end = pos + len(line)
        body = line[QUOTE.match(line).end():]
        found = FENCE.match(line)
        blank = not body.strip()
        if opening is None:
            # リストの中の 4 字下げは項目の続きで、コードではない
            indented = not blank and bool(INDENTED.match(body)) and (previous_blank or indented) and not in_list
            if indented:
                mask[pos:end] = b"\1" * (end - pos)
            elif found:
                opening = found.group(1)
                mask[pos:end] = b"\1" * (end - pos)
            if not blank and not INDENTED.match(body):
                in_list = bool(LIST_ITEM.match(body))
        else:
            mask[pos:end] = b"\1" * (end - pos)
            if found and found.group(1)[0] == opening[0] and len(found.group(1)) >= len(opening):
                opening = None
        previous_blank = blank
        pos = end + 1


def protected(text):
    """触らない文字の位置を 1 にした bytearray。"""
    mask = bytearray(len(text))
    _fenced(text, mask)
    for pattern in (FRONTMATTER, RAW_HTML) + PROTECTED:
        for m in pattern.finditer(text):
            mask[m.start():m.end()] = b"\1" * (m.end() - m.start())
    return mask


def _word(text, mask, start, step):
    """start から step 方向に、空白も日本語も保護も挟まない ASCII の並びを取る。"""
    i = start
    while 0 <= i < len(text) and not mask[i] and "!" <= text[i] <= "~":
        i += step
    return text[start:i] if step > 0 else text[i + 1:start + 1]


def _ja_side(text, mask, start, step):
    """start から step 方向に、空白・保護・日本語の句読点の手前までの並びを取る。"""
    i = start
    while 0 <= i < len(text) and not mask[i] and not text[i].isspace() and text[i] not in JA_STOP:
        i += step
    return text[start:i] if step > 0 else text[i + 1:start + 1]


def keeps(word, line_head):
    """語の隣の空白を残すか。"""
    if not TOKEN.fullmatch(word) or HYPHENATED.search(word):
        return True
    if word.endswith(")") and "(" not in word or word.endswith("]") and "[" not in word:
        return True
    if line_head and re.fullmatch(r"\d+[.)]", word):
        return True
    core = word.strip("()[]")
    return bool(FILE_NAME.fullmatch(core) or SHA.fullmatch(core))


def tighten(text, lines=None):
    """詰めてよい空白を詰めた本文。lines（1 始まりの行番号の集合）を渡すとその行だけを直す。"""
    if not text or (lines is not None and not lines):
        return text
    mask = protected(text)
    starts = [0] + [m.end() for m in re.finditer("\n", text)]
    drop = []
    for m in SPACES.finditer(text):
        s, e = m.span()
        if s == 0 or e >= len(text) or mask[s] or mask[e - 1]:
            continue
        if lines is not None and bisect.bisect_right(starts, s) not in lines:
            continue
        left, right = text[s - 1], text[e]
        if JA.match(left) and not JA.match(right):
            word = _word(text, mask, e, 1)
            other = _ja_side(text, mask, s - 1, -1)
            head = False
        elif JA.match(right) and not JA.match(left):
            word = _word(text, mask, s - 1, -1)
            other = _ja_side(text, mask, e, 1)
            head = not text[starts[bisect.bisect_right(starts, s) - 1]:s - len(word)].strip()
        else:
            continue
        if word and not keeps(word, head) and not PATH_LIKE.search(other):
            drop.append((s, e))
    if not drop:
        return text
    out = []
    pos = 0
    for s, e in drop:
        out.append(text[pos:s])
        pos = e
    out.append(text[pos:])
    return "".join(out)
