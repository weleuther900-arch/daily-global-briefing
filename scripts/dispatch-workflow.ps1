[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
  [string]$Repository,

  [ValidateSet('scan', 'final', 'recovery', 'case')]
  [string]$Mode = 'final',

  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'

try {
  $gh = (Get-Command gh -ErrorAction Stop).Source
  Write-Output "[$(Get-Date -Format 's')] Requesting $Mode workflow for $Repository."
  & $gh workflow run daily-briefing.yml --repo $Repository --ref $Branch --field "mode=$Mode" --field 'allow_send=true'
  if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI exited with code $LASTEXITCODE."
  }
  Write-Output "[$(Get-Date -Format 's')] Workflow dispatch accepted."
} catch {
  Write-Error "Unable to dispatch Daily Global Briefing: $($_.Exception.Message)"
  exit 1
}
