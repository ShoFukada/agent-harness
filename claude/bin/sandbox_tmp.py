"""worker は sandbox の中から一時領域（/tmp/claude-<uid>）に symlink や hard link を置けるので、
外で動く側がパスをそのまま開くと、鍵のファイルを読まされたり任意の場所を上書きさせられたりする。
外で動く側は、worker の settings の denyRead も自分で塞ぐ（worker_denied_paths）。
"""

import json
import os
import stat
import sys


def worker_denied_paths():
    """worker の settings（$ORCA_WORKER_SETTINGS）の denyRead を絶対パスにする。glob は手前の階層ごと塞ぐ。
    settings はこのリポジトリの外（nix-darwin など）に置くので環境変数で受け取り、無ければ塞ぐ一覧なしで外に出さずに止める。
    worker はコマンドの前に変数を付けられない（sandbox-exclude-guard が止める）ので、値は起動した環境のもの。"""
    path = os.environ.get("ORCA_WORKER_SETTINGS")
    if not path:
        sys.exit(f"{_prog()}: $ORCA_WORKER_SETTINGS（worker の settings のパス）が無い")
    with open(path) as f:
        deny = json.load(f)["sandbox"]["filesystem"]["denyRead"]
    out = []
    for p in deny:
        p = os.path.expanduser(p)
        if any(c in p for c in "*?["):
            p = os.path.dirname(p.split("*")[0].split("?")[0].split("[")[0])
        out.append(os.path.realpath(p))
    return sorted(set(out))


def tmp_root():
    # 最後の段は解決しない。/tmp/claude-<uid> そのものが symlink だと、境界が指す先（一時領域の外）に移ってしまう。
    # 解決しなければ、symlink の先のパスはこの境界の外になり、open_dir_nofollow が断る
    return os.path.join(os.path.realpath("/tmp"), f"claude-{os.getuid()}")


def _prog():
    return os.path.basename(sys.argv[0]) if sys.argv and sys.argv[0] else "sandbox_tmp"


def open_dir_nofollow(path):
    real = os.path.realpath(path)
    root = tmp_root()
    if os.path.commonpath([real, root]) != root:
        sys.exit(f"{_prog()}: {path} は {root} の中に置く")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    for part in [p for p in real.split("/") if p]:
        try:
            nfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        finally:
            os.close(fd)
        fd = nfd
    return fd


def read_file(path, limit=None):
    dfd = open_dir_nofollow(os.path.dirname(os.path.abspath(path)))
    try:
        # O_NONBLOCK: FIFO を置かれても書き手を待って止まらず、下の S_ISREG で断る
        fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
    finally:
        os.close(dfd)
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        # hard link は O_NOFOLLOW で止まらず、一時領域の外のファイルを指せる
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            sys.exit(f"{_prog()}: {path} は hard link のない普通のファイルにする")
        if limit is None:
            return f.read()
        data = f.read(limit + 1)  # fstat のあとに追記されても上限より多くは読まない
        if len(data) > limit:
            sys.exit(f"{_prog()}: {path} が {limit} バイトを超える")
        return data


def write_file(path, data, overwrite=True):
    """新しいファイルに書く。overwrite なら書いてから置き換え、既存のファイル（hard link 先かもしれない）を切り詰めない。
    overwrite でなければ、同じ名前があると FileExistsError にする。"""
    dfd = open_dir_nofollow(os.path.dirname(os.path.abspath(path)))
    try:
        name = os.path.basename(path)
        tmp = f".{name}.{os.getpid()}.tmp" if overwrite else name
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if overwrite:
            os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    finally:
        os.close(dfd)
