#!/bin/bash
# 人間が読む日本語を別系統のモデルに書き直させる。第1引数は pre（gh の本文）・post（書いた直後の空白の詰めと lint）・stop（.md / .html）
# JA_REVIEW_SKIP=1 を環境に置くと黙る。JA_REVIEW_ACTIVE=1 は書き直し役の中からの再入を止める
[ -n "${JA_REVIEW_SKIP-}" ] && exit 0
[ -n "${JA_REVIEW_ACTIVE-}" ] && exit 0
here=$(cd "$(dirname "$0")" && pwd)
exec /usr/bin/env python3 "$here/ja-review.py" --hook "${1:-stop}"
