# Install Naukri Windows Task Scheduler Tasks
# Executed in PowerShell environment

$projectDir = "c:\Users\JAWAD KOROTH\Documents\auto-job-openclaw\auto-job-openclaw"
$nodePath = (Get-Command node).Source

if (-not $nodePath) {
    $nodePath = "C:\Program Files\nodejs\node.exe"
}

Write-Host "Project Working Directory: $projectDir"
Write-Host "Node Executable Path:     $nodePath"

# 1. Profile Refresh Task (09:30 AM IST & 14:00 PM IST)
$refreshTaskName = "Naukri-Profile-Refresh"
$refreshScript = "$projectDir\scripts\run-naukri-profile-refresh.js"

$refreshTrigger1 = New-ScheduledTaskTrigger -Daily -At 9:30AM
$refreshTrigger2 = New-ScheduledTaskTrigger -Daily -At 2:00PM

$refreshAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$refreshScript`"" -WorkingDirectory $projectDir

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
    -Description "Naukri Candidate Profile Refresh 09:30 & 14:00 IST Task" `
    -Force

Write-Host "✅ Registered Task Scheduler Task: $refreshTaskName"

# 2. Job Application Automation Task (09:45 AM IST & 14:15 PM IST)
$jobTaskName = "Naukri-Job-Automation"
$jobScript = "$projectDir\scripts\run-naukri-production.js"

$jobTrigger1 = New-ScheduledTaskTrigger -Daily -At 9:45AM
$jobTrigger2 = New-ScheduledTaskTrigger -Daily -At 2:15PM

$jobAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$jobScript`"" -WorkingDirectory $projectDir

Register-ScheduledTask `
    -TaskName $jobTaskName `
    -Trigger @($jobTrigger1, $jobTrigger2) `
    -Action $jobAction `
    -Settings $settings `
    -Description "Naukri Production Job Automation 09:45 & 14:15 IST Task" `
    -Force

Write-Host "✅ Registered Task Scheduler Task: $jobTaskName"
