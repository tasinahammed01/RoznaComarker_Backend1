# Default is read-only. Run with literal --apply to rebuild this untracked QA archive
# without credential entries. No credential payload is opened or printed.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$artifactWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$archivePath = [IO.Path]::GetFullPath((Join-Path $artifactWorkspace 'tmp\real-ocr-qa\comarker.zip'))
if (-not $archivePath.StartsWith($artifactWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive target outside workspace' }
$applyRequested = $args -contains '--apply'
$sourceArchive = [IO.Compression.ZipFile]::OpenRead($archivePath)
$temporaryPath = $archivePath + '.sanitized.tmp'
try {
  $sensitiveNames = @($sourceArchive.Entries | Where-Object { $_.FullName -match '(^|/)(\.env($|\.(?!example|sample))|vision_key\.json$)' } | ForEach-Object FullName)
  [pscustomobject]@{ DryRun = -not $applyRequested; Archive = 'tmp/real-ocr-qa/comarker.zip'; SensitiveEntryNames = $sensitiveNames; EntryCount = $sourceArchive.Entries.Count } | ConvertTo-Json -Compress
  if (-not $applyRequested -or $sensitiveNames.Count -eq 0) { return }
  if (Test-Path -LiteralPath $temporaryPath) { throw 'Sanitized temporary target already exists' }
  $destinationArchive = [IO.Compression.ZipFile]::Open($temporaryPath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($entry in $sourceArchive.Entries) {
      if ($sensitiveNames -contains $entry.FullName) { continue }
      $copy = $destinationArchive.CreateEntry($entry.FullName, [IO.Compression.CompressionLevel]::Optimal)
      $copy.LastWriteTime = $entry.LastWriteTime
      if (-not $entry.FullName.EndsWith('/')) {
        $inputStream = $entry.Open(); $outputStream = $copy.Open()
        try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
      }
    }
  } finally { $destinationArchive.Dispose() }
} finally { $sourceArchive.Dispose() }
if ($applyRequested -and (Test-Path -LiteralPath $temporaryPath)) {
  $checkArchive = [IO.Compression.ZipFile]::OpenRead($temporaryPath)
  try {
    if (@($checkArchive.Entries | Where-Object { $_.FullName -match '(^|/)(\.env($|\.(?!example|sample))|vision_key\.json$)' }).Count) { throw 'Sanitization verification failed' }
  } finally { $checkArchive.Dispose() }
  Move-Item -LiteralPath $temporaryPath -Destination $archivePath -Force
  [pscustomobject]@{ Applied = $true; RemovedCredentialEntries = $sensitiveNames.Count } | ConvertTo-Json -Compress
}
