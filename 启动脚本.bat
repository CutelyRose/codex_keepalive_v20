@echo off
chcp 65001 >nul
pushd "%~dp0"
python "%~dp0codex_poll.py" %*
set "poll_exit_code=%errorlevel%"
popd
pause
exit /b %poll_exit_code%
