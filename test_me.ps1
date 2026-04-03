try {
  $r = Invoke-WebRequest -Uri "http://82.112.234.151:5000/api/auth/me" -Method GET -Headers @{Authorization="Bearer invalid"} -UseBasicParsing
  Write-Output $r.Content
} catch {
  Write-Output "Error"
  $_.Exception.Response.StatusCode
}
