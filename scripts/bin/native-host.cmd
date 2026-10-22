@echo off
rem WorkAssistant browser host (Windows): make sure the backend is running, then exit
"%~dp0..\runtime\node\node.exe" "%~dp0native-host.cjs" %*
