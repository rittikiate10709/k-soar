@echo off
rem ==========================================================================
rem  Smart Topology NOC - Windows agent installer
rem  1) Edit SERVER and KEY below (KEY = API Key type "agent" from Smart Topology)
rem  2) Put this file together with install-agent.ps1 and smart-topology-agent.ps1
rem     e.g. on \\fileserver\it$\smart-topology\  or a USB drive
rem  3) Right click > Run as administrator
rem     or GPO: Computer Configuration > Policies > Windows Settings > Scripts > Startup
rem             Script: install-agent.cmd   Parameters: /gpo
rem ==========================================================================
set SERVER=https://noc.hospital.local:3000
set KEY=stk_REPLACE_WITH_AGENT_KEY
set INTERVAL=60
rem When Smart Topology uses a self-signed certificate change the next line to:  set EXTRA=-SkipCertCheck
set EXTRA=

rem GPO mode: skip when already installed, never wait for a key press
if /I "%1"=="/gpo" (
  if exist "%ProgramData%\SmartTopology\config.json" schtasks /Query /TN "SmartTopology Agent" >nul 2>&1 && exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-agent.ps1" -Server "%SERVER%" -Key "%KEY%" -IntervalMinutes %INTERVAL% %EXTRA%
if /I not "%1"=="/gpo" pause
