@echo off
setlocal
title AI Knowledge Base Assistant

cd /d "%~dp0"
set "SYS=%SystemRoot%\System32"
set "PATH=%PATH%;%SYS%;%SystemRoot%"

echo ========================================
echo   AI Knowledge Base Assistant
echo ========================================
echo.

REM Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

REM Check dependencies
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed
        pause
        exit /b 1
    )
)

REM Check .env.local
if not exist ".env.local" (
    echo Creating .env.local...
    (
        echo DEEPSEEK_API_KEY=your-api-key-here
        echo DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
        echo DEEPSEEK_MODEL_CHAT=deepseek-chat
        echo DEEPSEEK_MODEL_REASONER=deepseek-reasoner
        echo DEEPSEEK_MAX_TOKENS=4096
        echo DEEPSEEK_TIMEOUT_MS=60000
    ) > .env.local
    echo [INFO] Please edit .env.local with your real API Key
)

REM Check knowledge base
if not exist "data\knowledge-base.txt" (
    if exist "docs" (
        echo Building knowledge base...
        call npx tsx scripts/build-knowledge.ts
    )
)

echo.
echo Starting server...
echo.

REM Free port 3000 if occupied
for /f "tokens=5" %%a in ('%SYS%\netstat.exe -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
    echo Port 3000 occupied ^(PID: %%a^), releasing...
    %SYS%\taskkill.exe /F /PID %%a >nul 2>nul
)

REM Open browser after a delay (in background)
start "" /min "%SYS%\cmd.exe" /c "timeout /t 8 /nobreak >nul && start http://localhost:3000/chat"

echo ========================================
echo   Server starting...
echo   URL: http://localhost:3000/chat
echo   Browser will open automatically
echo   Press Ctrl+C to stop
echo ========================================
echo.

REM Start dev server (foreground, blocks here)
call npm run dev

pause
