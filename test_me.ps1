try {
  $r = Invoke-WebRequest -Uri "http://localhost:5000/api/auth/me" -Method GET -Headers @{Authorization="Bearer invalid"} -UseBasicParsing
  Write-Output $r.Content
} catch {
  Write-Output "Error"
  $_.Exception.Response.StatusCode
}
