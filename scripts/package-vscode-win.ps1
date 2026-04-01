<#
.SYNOPSIS
    Continue VSCode extension packaging script (Windows, win32-x64)
.DESCRIPTION
    Builds and packages the Continue VSCode extension into a .vsix file.
    Output: extensions/vscode/build/continue-*.vsix
.PARAMETER Target
    Platform target, default: win32-x64
.PARAMETER SkipInstalls
    Skip npm install steps (use when dependencies are already installed)
.PARAMETER SkipGui
    Skip GUI build (use when gui/dist/ already exists)
.EXAMPLE
    .\scripts\package-vscode-win.ps1
    .\scripts\package-vscode-win.ps1 -SkipInstalls -SkipGui
    .\scripts\package-vscode-win.ps1 -Target linux-x64
#>
param(
    [string]$Target = "win32-x64",
    [switch]$SkipInstalls,
    [switch]$SkipGui
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $root

function Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

try {
    # 1. Root packages
    if (-not $SkipInstalls) {
        Step "npm install (root)"
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }

    Step "Build local packages (config-types, fetch, openai-adapters, etc.)"
    node ./scripts/build-packages.js
    if ($LASTEXITCODE -ne 0) { throw "build-packages failed" }

    # 2. Core
    Step "Core"
    Push-Location core
    if (-not $SkipInstalls) { npm install; if ($LASTEXITCODE -ne 0) { throw "core npm install failed" } }
    npm link
    Pop-Location

    # 3. GUI
    if (-not $SkipGui) {
        Step "GUI build"
        Push-Location gui
        if (-not $SkipInstalls) {
            npm install
            if ($LASTEXITCODE -ne 0) { throw "gui npm install failed" }
            npm link @continuedev/core
        }
        $env:NODE_OPTIONS = "--max-old-space-size=4096"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "gui build failed" }
        $env:NODE_OPTIONS = $null
        Pop-Location
    }

    # 4. VSCode extension
    Step "VSCode extension ($Target)"
    Push-Location extensions/vscode
    if (-not $SkipInstalls) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "vscode npm install failed" }
        npm link @continuedev/core
    }
    npm run prepackage -- --target $Target
    if ($LASTEXITCODE -ne 0) { throw "prepackage failed" }

    # esbuild (vscode:prepublish runs minified build automatically via vsce)
    # But we need esbuild available:
    npm install -f esbuild 2>$null

    npm run package -- --target $Target
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed" }
    Pop-Location

    # Done
    Step "Done"
    $vsix = Get-ChildItem "extensions/vscode/build/*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($vsix) {
        Write-Host "VSIX: $($vsix.FullName)" -ForegroundColor Green
        Write-Host "Size: $([math]::Round($vsix.Length / 1MB, 1)) MB" -ForegroundColor Green
    }
}
catch {
    Write-Host "`nERROR: $_" -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}
