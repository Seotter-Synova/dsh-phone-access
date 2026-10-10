@echo off
chcp 65001 >nul
title phone access to DSH
rem 手机访问 DSH：双击本文件 = 按需启动中继与隧道，然后打开访问页面（含二维码）。
rem
rem 用法（两种都行）：
rem   1) 把本文件复制到任意位置、双击即可 —— 需要把下面那行改成你的实际路径；
rem   2) 或者直接双击 phone-access 目录里的 phone-access.cmd（它自动推导路径，不用改）。
powershell -NoProfile -ExecutionPolicy Bypass -File "<工作区路径>\phone-access\phone-access.ps1"
