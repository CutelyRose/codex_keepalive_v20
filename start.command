#!/bin/sh
# macOS Finder / Terminal entry point.
set -eu
case $0 in
    /*) poll_command_path=$0 ;;
    *) poll_command_path=./$0 ;;
esac
poll_command_dir=$(CDPATH= cd -P "$(dirname "$poll_command_path")" && pwd)
exec /bin/sh "$poll_command_dir/start.sh" "$@"
