# Install LinkedIn Windows Task Scheduler Tasks with Offline-Aware Launcher Wrapper
# Executed in PowerShell environment

$projectDir = "c:\Users\JAWAD KOROTH\Documents\auto-job-openclaw\auto-job-openclaw"
$nodePath = (Get-Command node).Source

if (-not $nodePath) {
    $nodePath = "C:\Program Files\nodejs\node.exe"
}

$launcherScript = "$projectDir\scripts\linkedin-windows-launcher.js"

Write-Host "Project Working Directory: $projectDir"
Write-Host "Node Executable Path:     $nodePath"
Write-Host "Launcher Script Path:     $launcherScript"

# 1. Profile Refresh Task (09:00 AM IST & 01:30 PM IST)
$refreshTaskName = "LinkedIn-Profile-Refresh"

$refreshTrigger1 = New-ScheduledTaskTrigger -Daily -At 9:00AM
$refreshTrigger2 = New-ScheduledTaskTrigger -Daily -At 1:30PM

$refreshAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$launcherScript`" --task profile" -WorkingDirectory $projectDir

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $refreshTaskName `
    -Trigger @($refreshTrigger1, $refreshTrigger2) `
    -Action $refreshAction `
    -Settings $settings `
    -Description "LinkedIn Candidate Profile Refresh 09:00 & 13:30 IST Task" `
    -Force

Write-Host "✅ Registered Task Scheduler Task: $refreshTaskName (StartWhenAvailable = TRUE)"

# 2. Job Application Automation Task (09:15 AM IST & 01:45 PM IST)
$jobTaskName = "LinkedIn-Job-Automation"

$jobTrigger1 = New-ScheduledTaskTrigger -Daily -At 9:15AM
$jobTrigger2 = New-ScheduledTaskTrigger -Daily -At 1:45PM

$jobAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$launcherScript`" --task jobs" -WorkingDirectory $projectDir

Register-ScheduledTask `
    -TaskName $jobTaskName `
    -Trigger @($jobTrigger1, $jobTrigger2) `
    -Action $jobAction `
    -Settings $settings `
    -Description "LinkedIn Production Job Automation 09:15 & 13:45 IST Task" `
    -Force

Write-Host "✅ Registered Task Scheduler Task: $jobTaskName (StartWhenAvailable = TRUE)"
