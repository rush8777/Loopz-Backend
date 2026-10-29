[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Command
)

$ErrorActionPreference = "Stop"

# Local development is configured by Loopz-Backend/.env. PowerShell child
# processes inherit machine/user environment variables, and dotenv deliberately
# does not overwrite them. Clear only the AI variables here so an old key in the
# Windows environment cannot silently take precedence over the current .env.
$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
if (Test-Path -LiteralPath $envFile) {
    @(
        "AI_ENABLED",
        "AI_PROVIDER",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
        "GEMINI_API_KEY",
        "GEMINI_MODEL"
    ) | ForEach-Object {
        Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue
    }
}

# Node does not always receive the intermediate certificates that Windows uses
# for TLS validation. Export Windows' trusted root and intermediate stores for
# this local development process while retaining normal certificate validation.
$stores = @(
    @{ Name = "Root"; Location = "CurrentUser" },
    @{ Name = "CA"; Location = "CurrentUser" },
    @{ Name = "Root"; Location = "LocalMachine" },
    @{ Name = "CA"; Location = "LocalMachine" }
)
$certificates = foreach ($storeDefinition in $stores) {
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
        $storeDefinition.Name,
        [System.Security.Cryptography.X509Certificates.StoreLocation]$storeDefinition.Location
    )
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $store.Certificates
    }
    finally {
        $store.Close()
    }
}
if (-not $certificates) { throw "Could not read trusted Windows certificates." }

$bundlePath = Join-Path ([System.IO.Path]::GetTempPath()) "movcues-node-ca.pem"
$pem = foreach ($certificate in $certificates) {
    $base64 = [Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks)
    "-----BEGIN CERTIFICATE-----`r`n$base64`r`n-----END CERTIFICATE-----"
}
[System.IO.File]::WriteAllText($bundlePath, ($pem -join "`r`n"), [System.Text.UTF8Encoding]::new($false))

$env:NODE_EXTRA_CA_CERTS = $bundlePath
& $Command[0] @($Command | Select-Object -Skip 1)
exit $LASTEXITCODE
