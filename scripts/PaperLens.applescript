property paperLensURL : "http://localhost:3000/"

on run
	set projectPath to "__PROJECT_PATH__"
	set nodePath to "__NODE_PATH__"
	set logDirectory to POSIX path of (path to library folder from user domain) & "Logs/PaperLens"
	set executablePath to "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	
	set launchScript to "PATH=" & quoted form of executablePath & "; export PATH; " & ¬
		"project=" & quoted form of projectPath & "; logs=" & quoted form of logDirectory & "; " & ¬
		"/bin/mkdir -p \"$logs\"; cd \"$project\"; " & ¬
			"if ! /usr/bin/nc -z -w 1 127.0.0.1 43123 >/dev/null 2>&1 && ! /usr/bin/nc -z -w 1 ::1 3000 >/dev/null 2>&1 && ! /usr/bin/nc -z -w 1 127.0.0.1 3000 >/dev/null 2>&1; then " & ¬
			"nohup " & quoted form of nodePath & " \"$project/scripts/dev.mjs\" >>\"$logs/paperlens.log\" 2>&1 </dev/null & " & ¬
			"fi"
	
	try
		do shell script launchScript
	on error errorMessage
		display alert "PaperLens 无法启动" message errorMessage as critical
		return
	end try
	
	set serviceReady to false
	repeat 80 times
		try
			do shell script "(/usr/bin/nc -z -w 1 ::1 3000 >/dev/null || /usr/bin/nc -z -w 1 127.0.0.1 3000 >/dev/null) && /usr/bin/nc -z -w 1 127.0.0.1 43123 >/dev/null"
			set serviceReady to true
			exit repeat
		on error
			delay 0.25
		end try
	end repeat
	
	if serviceReady then
		open location paperLensURL
	else
		display alert "PaperLens 启动超时" message "请查看日志：" & logDirectory as critical
	end if
end run
