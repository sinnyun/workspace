@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

REM ============================================================================
REM  dev-start.bat — 一键启动开发环境
REM  检测环境 -> 清理端口 -> 安装依赖 -> 增量构建 -> 启动 Vite(HMR) -> 启动界面
REM
REM  用法：
REM    dev-start.bat               完整流程
REM    dev-start.bat --skip-port    不清理 1420 端口
REM    dev-start.bat --skip-build   跳过构建，只拉起 dev server + 界面
REM    dev-start.bat --browser      只启动 Vite（浏览器调试，不编译 Rust/不开窗口）
REM
REM  本脚本会自动在一个新窗口中以 cmd /k 运行，出错或结束时窗口都会保留，
REM  方便你查看错误信息（按任意键可退出该窗口）。
REM ============================================================================

REM —— 首次（外层）调用：在新窗口内以 /k 方式重跑自身，保证窗口不会自动关闭 ——
if not "%FM_DEV_RUN%"=="1" (
  set "FM_DEV_RUN=1"
  start "File Manager Dev" cmd /k ""%~f0" %*"
  exit /b
)

cd /d "%~dp0"
set "ROOT=%CD%"
set "DEV_PORT=1420"
set "LOG=%ROOT%\dev-start.log"
echo [%date% %time%] dev-start 开始 > "%LOG%"

set "SKIP_PORT=0"
set "SKIP_BUILD=0"
set "BROWSER_ONLY=0"
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--skip-port"  set "SKIP_PORT=1"
if /i "%~1"=="--skip-build" set "SKIP_BUILD=1"
if /i "%~1"=="--browser"    set "BROWSER_ONLY=1"
shift
goto parse_args
:args_done

echo ============================================================================
echo  [1/6] 环境检测
echo ============================================================================

set "FAIL=0"

where node  >nul 2>&1
if errorlevel 1 (echo   [x] 未找到 node（需 Node 18+） & set "FAIL=1") else (for /f "delims=" %%v in ('node -v') do echo   node    %%v)

where pnpm  >nul 2>&1
if errorlevel 1 (echo   [x] 未找到 pnpm（npm i -g pnpm） & set "FAIL=1") else (for /f "delims=" %%v in ('pnpm -v') do echo   pnpm    %%v)

where cargo >nul 2>&1
if errorlevel 1 (echo   [x] 未找到 cargo（安装 Rust toolchain） & set "FAIL=1") else (for /f "delims=" %%v in ('cargo --version') do echo   cargo   %%v)

REM Tauri CLI 来自 shell-ui 的 devDependency；apps/host 没有 node_modules，须直接调用其 bin
set "TAURI=%ROOT%\apps\shell-ui\node_modules\.bin\tauri.cmd"
if not exist "%TAURI%" (
  echo   [!] 暂未找到 Tauri CLI（依赖安装后生成），稍后会在第 3 步自动安装
) else (
  echo   tauri   found
)

REG QUERY "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Client" /v version >nul 2>&1
if errorlevel 1 (
  echo   [!] 未检测到 WebView2 Runtime，界面窗口可能无法显示（请安装 Edge WebView2 Runtime）
) else (
  echo   webview2 ok
)

if "%FAIL%"=="1" (
  echo.
  echo   环境不完整，已中止。请补齐上面标记 [x] 的工具后重试。
  echo   [env-incomplete] >> "%LOG%"
  pause
  exit /b 1
)

echo ============================================================================
echo  [2/6] 清理端口占用（:%DEV_PORT%）
echo ============================================================================

if "%SKIP_PORT%"=="1" (
  echo   已跳过（--skip-port）
  goto after_port
)

set "KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%DEV_PORT% " ^| findstr /i "LISTENING"') do (
  if not "%%p"=="0" (
    echo   结束占用 :%DEV_PORT% 的进程 PID=%%p ...
    taskkill /F /PID %%p >nul 2>&1 && set "KILLED=1"
  )
)
if "!KILLED!"=="1" (echo   端口已释放) else (echo   :%DEV_PORT% 无占用)
:after_port

echo ============================================================================
echo  [3/6] 安装依赖
echo ============================================================================

if exist "%ROOT%\node_modules\" (
  echo   node_modules 已存在，跳过 pnpm install
) else (
  echo   首次安装：pnpm install ...
  call pnpm install
  if errorlevel 1 (
    echo   [x] pnpm install 失败（错误码 !ERRORLEVEL!），详见上方输出与 "%LOG%"
    echo   [pnpm-install-failed code=!ERRORLEVEL!] >> "%LOG%"
    pause & exit /b 1
  )
)

echo ============================================================================
echo  [4/6] 增量构建（共享单例 + 前端插件）
echo ============================================================================

if "%SKIP_BUILD%"=="1" (
  echo   已跳过（--skip-build）
  goto launch
)

echo   pnpm build:shared ...
call pnpm build:shared
if errorlevel 1 (
  echo   [x] build:shared 失败（错误码 !ERRORLEVEL!）
  echo   [build-shared-failed code=!ERRORLEVEL!] >> "%LOG%"
  pause & exit /b 1
)

if exist "%ROOT%\plugins\" (
  echo   pnpm build:plugins ...
  call pnpm build:plugins
  if errorlevel 1 echo   [!] build:plugins 失败（继续，但运行期插件可能缺失）
) else (
  echo   无 plugins 目录，跳过 build:plugins
)

:launch
echo ============================================================================
echo  [5/6] 启动前端 dev server（Vite :%DEV_PORT%，HMR 热更新）
echo ============================================================================

start "File-Manager Vite dev :%DEV_PORT%" /D "%ROOT%\apps\shell-ui" cmd /k "pnpm dev"

set /a "TRY=0"
:wait_vite
set "UP=0"
for /f "tokens=*" %%a in ('netstat -ano ^| findstr ":%DEV_PORT% " ^| findstr /i "LISTENING"') do set "UP=1"
if "%UP%"=="1" goto vite_ready
set /a "TRY+=1"
if !TRY! GEQ 30 (
  echo   [x] 等待 Vite 启动超时（:%DEV_PORT% 未就绪）。请查看上面 Vite 窗口的报错。
  echo   [vite-timeout] >> "%LOG%"
  pause & exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait_vite
:vite_ready
echo   Vite 已就绪：http://localhost:%DEV_PORT%

if "%BROWSER_ONLY%"=="1" (
  echo.
  echo   仅浏览器模式：在浏览器打开 http://localhost:%DEV_PORT% 即可。
  goto end
)

echo ============================================================================
echo  [6/6] 启动界面（tauri dev：Rust 增量热编译 + 前端 HMR）
echo ============================================================================

if not exist "%TAURI%" (
  echo   [x] 仍找不到 Tauri CLI：%TAURI%
  echo       请确认 pnpm install 已成功（该文件由 shell-ui 的 @tauri-apps/cli 生成）。
  echo   [tauri-cli-missing] >> "%LOG%"
  pause & exit /b 1
)

echo   工作目录：%ROOT%\apps\host（tauri.conf.json 在此，自动识别）
pushd "%ROOT%\apps\host"
call "%TAURI%" dev
set "TAURI_EXIT=!ERRORLEVEL!"
popd

if not "!TAURI_EXIT!"=="0" (
  echo.
  echo   [x] tauri dev 以退出码 !TAURI_EXIT! 结束。
  echo       常见原因：Rust 编译错误、端口占用、WebView2 缺失。请查看上方日志。
  echo   [tauri-dev-exit code=!TAURI_EXIT!] >> "%LOG%"
  goto die
)

echo   界面已正常退出。
goto end

:die
echo ============================================================================
echo  出错了。上方即为错误输出；本窗口不会自动关闭。
echo  日志：%LOG%
echo ============================================================================
pause
exit /b 1

:end
echo ============================================================================
echo  完成。日志：%LOG%
echo  提示：Vite 窗口与 Rust 变更会热更新；关闭界面窗口即可停止 tauri。
echo ============================================================================
pause
exit /b 0
