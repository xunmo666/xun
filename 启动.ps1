# AI 知识库助手 - 一键启动脚本 (PowerShell)
# 右键 -> 使用 PowerShell 运行，或在 PowerShell 中执行: .\启动.ps1

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AI 知识库助手 - 启动中..." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 切换到脚本所在目录
Set-Location $PSScriptRoot

# 确保 System32 在 PATH 中
$env:Path += ";C:\Windows\System32;C:\Windows"

# 检查 Node.js
Write-Host "[1/5] 检查 Node.js 环境..." -ForegroundColor Yellow
try {
    $nodeVer = node -v
    Write-Host "      Node.js 版本: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[错误] 未检测到 Node.js，请安装: https://nodejs.org/" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}

# 检查依赖
Write-Host "[2/5] 检查项目依赖..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
    Write-Host "      未找到 node_modules，正在安装依赖..." -ForegroundColor Gray
    Write-Host "      （首次安装可能需要 1-3 分钟）" -ForegroundColor Gray
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] 依赖安装失败" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit 1
    }
    Write-Host "      依赖安装完成" -ForegroundColor Green
} else {
    Write-Host "      依赖已安装" -ForegroundColor Green
}

# 检查 .env.local
Write-Host "[3/5] 检查配置文件..." -ForegroundColor Yellow
if (-not (Test-Path ".env.local")) {
    Write-Host "      未找到 .env.local，正在创建..." -ForegroundColor Gray
    @"
DEEPSEEK_API_KEY=your-api-key-here
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL_CHAT=deepseek-chat
DEEPSEEK_MODEL_REASONER=deepseek-reasoner
DEEPSEEK_MAX_TOKENS=4096
DEEPSEEK_TIMEOUT_MS=60000
"@ | Out-File -FilePath ".env.local" -Encoding utf8
    Write-Host "      已创建 .env.local" -ForegroundColor Green
    Write-Host "      [提示] 请编辑 .env.local 填入真实 API Key" -ForegroundColor Yellow
} else {
    Write-Host "      .env.local 已存在" -ForegroundColor Green
}

# 检查知识库
Write-Host "[4/5] 检查知识库..." -ForegroundColor Yellow
if (-not (Test-Path "data\knowledge-base.txt")) {
    if (Test-Path "docs") {
        Write-Host "      正在构建知识库..." -ForegroundColor Gray
        npx tsx scripts/build-knowledge.ts
    }
} else {
    Write-Host "      知识库已就绪" -ForegroundColor Green
}

# 启动开发服务器
Write-Host "[5/5] 启动开发服务器..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  访问地址: http://localhost:3000/chat" -ForegroundColor Cyan
Write-Host "  按 Ctrl+C 停止服务器" -ForegroundColor Gray
Write-Host ""

# 检查并释放端口 3000
$portConn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($portConn) {
    $portConn | ForEach-Object {
        if ($_.OwningProcess -ne 0) {
            Write-Host "  端口 3000 被占用（PID: $($_.OwningProcess)），正在释放..." -ForegroundColor Yellow
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 3秒后打开浏览器
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:3000/chat"
} | Out-Null

# 启动 Next.js
npm run dev
