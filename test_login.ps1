$headers = @{
  "Content-Type" = "application/json"
  "Authorization" = "Bearer invalid"
}
$body = ""
try {
  $response = Invoke-WebRequest -Uri "http://localhost:5000/api/auth/login" -Method POST -Headers $headers -Body $body -UseBasicParsing
  $response.Content
} catch {
  $_.Exception.Message
  if ($_.Exception.Response) {
    $_.Exception.Response.StatusCode.value__
    $_.Exception.Response.StatusDescription
  }
}
