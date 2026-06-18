# Push to https://github.com/Ybssss/sms-mail-receiver
# Usage:
#   .\scripts\push-to-github.ps1
#   .\scripts\push-to-github.ps1 -CommitMessage "update mail receiver"

param(
  [string]$RemoteUrl = "https://github.com/Ybssss/sms-mail-receiver.git",
  [string]$CommitMessage = "first commit",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "Project: $ProjectRoot" -ForegroundColor Cyan
Write-Host "Remote:  $RemoteUrl" -ForegroundColor Cyan

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Require-Command git

if (-not (Test-Path ".git")) {
  git init
}

if (Test-Path ".env") {
  $trackedEnv = git ls-files --error-unmatch .env 2>$null
  if ($trackedEnv) {
    throw ".env is tracked by git. Run: git rm --cached .env"
  }
  Write-Host "OK: .env is gitignored." -ForegroundColor Green
}

$status = git status --porcelain
if ($status) {
  git add -A
  git commit -m $CommitMessage
  Write-Host "Committed changes." -ForegroundColor Green
} else {
  Write-Host "No file changes to commit." -ForegroundColor Yellow
}

git branch -M $Branch

$remotes = git remote
if (-not $remotes) {
  git remote add origin $RemoteUrl
  Write-Host "Added remote origin." -ForegroundColor Green
} else {
  $currentUrl = git remote get-url origin 2>$null
  if ($currentUrl -ne $RemoteUrl) {
    Write-Host "Updating origin: $currentUrl -> $RemoteUrl" -ForegroundColor Yellow
    git remote set-url origin $RemoteUrl
  }
}

Write-Host "Pushing to origin/$Branch..." -ForegroundColor Cyan

git fetch origin $Branch 2>$null
$hasRemoteBranch = git rev-parse --verify "origin/$Branch" 2>$null
if ($LASTEXITCODE -eq 0) {
  git pull --rebase origin $Branch
}

git push -u origin $Branch

Write-Host ""
Write-Host "Done: https://github.com/Ybssss/sms-mail-receiver" -ForegroundColor Green
