@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

echo ==========================================================
echo    骑行轨迹地图 - 本地服务器（可选）
echo ==========================================================
echo.
echo  【用 Edge 或 Chrome 的话，你不需要这个脚本】
echo    直接双击 index.html 就能用，轨迹会存在浏览器的
echo    IndexedDB 里，容量有数百 MB，够存几千次骑行。
echo.
echo  【用 Firefox 的话，需要这个脚本】
echo    Firefox 从 68 版起把每个本地文件当成独立来源，
echo    在 file:// 下 IndexedDB 和本地存储都用不了 ——
echo    页面能打开，但导进去的轨迹关掉就没了
echo    （页面顶部会有一条明确的提示告诉你）。
echo    用这个脚本通过 http 打开就没这个问题。
echo.
echo  【另一个用处】
echo    想让手机也能看：把手机连到同一个 WiFi，
echo    在手机浏览器里输入下面显示的局域网地址。
echo.
echo  关闭这个黑窗口就停止服务器。
echo.

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)

if not defined PY (
  echo [提示] 没有找到 Python，没法启动服务器。
  echo.
  echo        用 Edge / Chrome 的话不影响 —— 直接双击 index.html 就行。
  echo        用 Firefox 又想要数据能存住的话，去
  echo        https://www.python.org/downloads/ 装个 Python 再运行本脚本。
  echo.
  pause
  exit /b 1
)

set "PORT=8777"

echo  ----------------------------------------------------------
echo   电脑上打开：  http://localhost:%PORT%/
echo   手机上打开：  先用 ipconfig 查到本机 IPv4 地址，
echo                 再访问   http://该地址:%PORT%/index.html
echo  ----------------------------------------------------------
echo.
echo  正在启动服务器 ...（按 Ctrl+C 可停止）
echo.

start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/index.html"

%PY% -m http.server %PORT%

echo.
echo 服务器已停止。
pause
