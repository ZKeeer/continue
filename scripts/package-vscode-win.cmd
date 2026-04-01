@echo off
setlocal enabledelayedexpansion
REM Continue VSCode extension packaging script (Windows, win32-x64)
REM Usage:
REM   scripts\package-vscode-win.cmd                     Full build
REM   scripts\package-vscode-win.cmd --skip-installs     Skip npm install
REM   scripts\package-vscode-win.cmd --skip-gui          Skip GUI build
REM   scripts\package-vscode-win.cmd --target linux-x64  Custom target
REM Flags can be combined.

set "TARGET=win32-x64"
set "SKIP_INSTALLS=0"
set "SKIP_GUI=0"

REM Save script directory before shift corrupts %0
set "SCRIPT_DIR=%~dp0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--skip-installs" ( set "SKIP_INSTALLS=1" & shift & goto :parse_args )
if /i "%~1"=="--skip-gui"      ( set "SKIP_GUI=1"      & shift & goto :parse_args )
if /i "%~1"=="--target"        ( set "TARGET=%~2"       & shift & shift & goto :parse_args )
echo Unknown argument: %~1
exit /b 1
:args_done

REM Resolve project root (scripts\..\)
pushd "%SCRIPT_DIR%.."
set "ROOT=%CD%"

echo.
echo === npm install (root) ===
if "%SKIP_INSTALLS%"=="0" (
    call npm install || goto :fail
)

echo.
echo === Build local packages ===
call node ./scripts/build-packages.js || goto :fail

echo.
echo === Core ===
pushd core
if "%SKIP_INSTALLS%"=="0" (
    call npm install || goto :fail
)
call npm link || goto :fail
popd

if "%SKIP_GUI%"=="1" goto :skip_gui_build
echo.
echo === GUI build ===
pushd gui
if "%SKIP_INSTALLS%"=="0" (
    call npm install || goto :fail
    call npm link @continuedev/core || goto :fail
)
set "NODE_OPTIONS=--max-old-space-size=4096"
call npm run build || goto :fail
set "NODE_OPTIONS="
popd
:skip_gui_build

echo.
echo === VSCode extension (%TARGET%) ===
pushd extensions\vscode
if "%SKIP_INSTALLS%"=="0" (
    call npm install || goto :fail
    call npm link @continuedev/core || goto :fail
)
call npm run prepackage -- --target %TARGET% || goto :fail
call npm install -f esbuild 2>nul
call npm run package -- --target %TARGET% || goto :fail
popd

echo.
echo === Done ===
for /f "delims=" %%F in ('dir /b /o-d "extensions\vscode\build\*.vsix" 2^>nul') do (
    echo VSIX: %ROOT%\extensions\vscode\build\%%F
    goto :found_vsix
)
echo WARNING: No .vsix file found in extensions\vscode\build\
:found_vsix

popd
exit /b 0

:fail
echo.
echo ERROR: Build failed at previous step.
popd
exit /b 1
