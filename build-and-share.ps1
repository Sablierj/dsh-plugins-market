$ErrorActionPreference = 'Continue'
$d   = 'C:\Users\win11\Documents\deepseek-harness\default-workspace\dsh-session-model-bridge'
$log = Join-Path $d 'build-log.txt'
Remove-Item $log -ErrorAction SilentlyContinue

function Log($m) { $m | Tee-Object -FilePath $log -Append | Out-Null }

$z     = 'C:\Users\win11\.dsh\sessions\--C-Users-win11-Documents-deepseek-harness-default-workspace--\session-8664632b-3ccc-42d5-afd5-5843031d4361\session.v4.jsonl.zstd'
$jsonl = Join-Path $d 'wechat-8664632b.jsonl'
$html  = Join-Path $d 'session-8664632b.html'
$pdf   = Join-Path $d 'session-8664632b.pdf'
$cli   = 'C:\Users\win11\.dsh\profiles\desktop\node_modules\@peng272\dsh-wechat-ilink\lib\cli.js'

Log "=== decode ==="
Log ((& node (Join-Path $d '.zstd-dump.mjs') $z $jsonl 2>&1 | Out-String))

Log "=== render ==="
Log ((& node (Join-Path $d 'render-transcript.mjs') $jsonl $html 2>&1 | Out-String))

Log "=== pdf ==="
Remove-Item $pdf -ErrorAction SilentlyContinue
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
$url = 'file:///' + ($html -replace '\\', '/')
$out = & $chrome --headless=new --disable-gpu --no-sandbox --no-pdf-header-footer "--user-data-dir=$d\.chrome-profile" "--print-to-pdf=$pdf" $url 2>&1 | Out-String
Log $out
for ($i = 0; $i -lt 20 -and -not (Test-Path $pdf); $i++) { Start-Sleep -Milliseconds 500 }
if (Test-Path $pdf) { Log ("PDF OK " + (Get-Item $pdf).Length + " bytes") } else { Log 'PDF FAILED' }

Log "=== share ==="
if (Test-Path $pdf) {
  Log ((& node $cli share $pdf 2>&1 | Out-String))
} else {
  Log 'skipped (no pdf)'
}
Log "=== done ==="
