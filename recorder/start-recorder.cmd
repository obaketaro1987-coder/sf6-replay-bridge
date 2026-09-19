@echo off
cd /d "%~dp0"
if not exist "config.json" (
  echo config.json がありません。config.example.json をコピーして設定してください。
  pause
  exit /b 1
)
npm start
if errorlevel 1 pause
