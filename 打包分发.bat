@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

echo ==========================================================
echo    骑行轨迹地图 - 打包成压缩包（发给别人用）
echo ==========================================================
echo.
echo  会生成一个 zip，里面只有运行需要的文件：
echo    index.html  css/  js/  lib/  使用说明.md  快速上手.txt
echo.
echo  下面这些不会被收进去（免得把不该给的东西也发出去）：
echo    dev/                开发与测试工具
echo    华为导出骑行文件/    你自己的骑行记录
echo    _*.html             测试产物
echo.
echo  生成好的压缩包就在本目录下，朋友解压后双击 index.html 即可使用。
echo.

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)

if not defined PY (
  echo [提示] 没有找到 Python，没法自动打包。
  echo.
  echo        你也可以自己手动打包，但要注意：
  echo        只把 index.html、css、js、lib 和「使用说明.md」放进压缩包，
  echo        dev 文件夹和「华为导出骑行文件」不要放进去。
  echo.
  pause
  exit /b 1
)

%PY% "dev\make-release.py"

echo.
pause
