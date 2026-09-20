#!/bin/sh
# Linux / macOS launcher. Keep paths and forwarded arguments intact.
set -eu
umask 077
case $0 in
    /*) poll_script_path=$0 ;;
    *) poll_script_path=./$0 ;;
esac
poll_script_dir=$(CDPATH= cd -P "$(dirname "$poll_script_path")" && pwd)
poll_python=
for poll_candidate in python3.14 python3.13 python3.12 python3.11 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3 python; do
    if command -v "$poll_candidate" >/dev/null 2>&1 &&
       "$poll_candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
        poll_python=$poll_candidate
        break
    fi
done
if [ -z "$poll_python" ]; then
    printf '%s\n' '需要 Python 3.11 或更新版本。请先安装 python3.11+，再运行本脚本。' >&2
    exit 127
fi
exec "$poll_python" -B -X utf8 "$poll_script_dir/codex_poll.py" "$@"
