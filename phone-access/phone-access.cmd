@echo off
chcp 65001 >nul
rem 手机访问 DSH：双击本文件 = 按需启动中继与隧道，然后打开访问页面（含二维码）。
rem 路径用 %~dp0 推导（本文件所在目录），换机器/换目录都不用改。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0phone-access.ps1"
