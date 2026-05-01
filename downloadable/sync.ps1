# sync-desktop.ps1 — Sync core files to the downloadable folder
$Files = @(
    "events.js",
    "core.js",
    "runtime.js",
    "graph.js",
    "render.js",
    "editor.js",
    "lens.js",
    "script.js",
    "terminal.js",
    "ui.js",
    "demos.js",
    "examples.js",
    "styles.css",
    "demos.css",
    "favicon.png",
    "favicon.svg"
)

foreach ($f in $Files) {
    Copy-Item "..\$f" ".\" -Force
    Write-Host "Synced: $f" -ForegroundColor Green
}

Write-Host "Sync complete!" -ForegroundColor Cyan
