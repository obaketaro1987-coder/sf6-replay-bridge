@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20以上が必要です。https://nodejs.org/ からLTS版をインストールしてください。
  pause
  exit /b 1
)
call npm install
if errorlevel 1 (
  echo インストールに失敗しました。
  pause
  exit /b 1
)
if not exist "config.json" copy "config.example.json" "config.json" >nul
echo.
echo インストール完了。config.jsonを設定してから start-recorder.cmd を実行してください。
pause
