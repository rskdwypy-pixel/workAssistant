' WorkAssistant: start the background supervisor with a hidden window.
' Used by the per-user autostart entry (HKCU Run) and by the browser host.
' Keep this file ASCII-only: wscript reads it with the system ANSI code page.
Set fso = CreateObject("Scripting.FileSystemObject")
binDir = fso.GetParentFolderName(WScript.ScriptFullName)
waHome = fso.GetParentFolderName(binDir)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = waHome
sh.Run """" & waHome & "\runtime\node\node.exe"" """ & binDir & "\supervisor.cjs""", 0, False
