' run-ps-jsx.vbs — 通过 COM 让 Photoshop 执行 JSX 脚本
' 用法: cscript //nologo run-ps-jsx.vbs "<jsx绝对路径>"
Option Explicit
Dim fso, jsxPath, ps
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 1 Then
    WScript.Echo "ERROR: need jsx path"
    WScript.Quit 2
End If
jsxPath = WScript.Arguments(0)
If Not fso.FileExists(jsxPath) Then
    WScript.Echo "ERROR: jsx not found: " & jsxPath
    WScript.Quit 3
End If

On Error Resume Next
Set ps = CreateObject("Photoshop.Application")
If Err.Number <> 0 Then
    WScript.Echo "ERROR: cannot create Photoshop.Application: " & Err.Description
    WScript.Quit 4
End If
Err.Clear

ps.DoJavaScriptFile jsxPath
If Err.Number <> 0 Then
    WScript.Echo "ERROR: DoJavaScriptFile failed: " & Err.Description
    WScript.Quit 5
End If

WScript.Echo "OK: jsx executed"
WScript.Quit 0
