# Android SDK (no Android Studio) + Gradle for building the FAN engine APK. Run once in 64-bit PowerShell.
# Downloads: cmdline-tools (~150 MB, dl.google.com), platform-tools + platforms;android-35 + build-tools;35.0.0 (~600 MB),
# gradle-8.11.1-bin.zip (~130 MB, services.gradle.org). Installs into $env:LOCALAPPDATA\Android\Sdk and $env:LOCALAPPDATA\Gradle.
# ASCII only: PowerShell 5.1 reads BOM-less files as ANSI.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$tools = Join-Path $sdk 'cmdline-tools\latest'
$gradleHome = Join-Path $env:LOCALAPPDATA 'Gradle\gradle-8.11.1'
$tmp = Join-Path $env:TEMP 'fan-android-setup'
New-Item -ItemType Directory -Force $sdk, $tmp | Out-Null

if (-not (Test-Path (Join-Path $tools 'bin\sdkmanager.bat'))) {
    Write-Host '[1/4] cmdline-tools'
    $zip = Join-Path $tmp 'cmdline-tools.zip'
    Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' -OutFile $zip
    Expand-Archive $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force (Split-Path $tools) | Out-Null
    if (Test-Path $tools) { Remove-Item $tools -Recurse -Force }
    Move-Item (Join-Path $tmp 'cmdline-tools') $tools -Force
}
if (-not $env:JAVA_HOME) {
    $env:JAVA_HOME = (Get-ChildItem "$env:USERPROFILE\.jdks" -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
}
Write-Host "JAVA_HOME=$env:JAVA_HOME"
$sdkmanager = Join-Path $tools 'bin\sdkmanager.bat'
Write-Host '[2/4] licenses'
$yes = ('y' + [Environment]::NewLine) * 12
$yes | & $sdkmanager --sdk_root=$sdk --licenses | Out-Null
Write-Host '[3/4] platform-tools, platforms;android-35, build-tools;35.0.0'
& $sdkmanager --sdk_root=$sdk 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
if ($LASTEXITCODE -ne 0) { throw "sdkmanager exit $LASTEXITCODE" }

if (-not (Test-Path (Join-Path $gradleHome 'bin\gradle.bat'))) {
    Write-Host '[4/4] gradle'
    $gz = Join-Path $tmp 'gradle.zip'
    Invoke-WebRequest 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip' -OutFile $gz
    Expand-Archive $gz -DestinationPath (Split-Path $gradleHome) -Force
}

[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdk, 'User')
$env:ANDROID_HOME = $sdk; $env:ANDROID_SDK_ROOT = $sdk
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($p in @((Join-Path $sdk 'platform-tools'), (Join-Path $gradleHome 'bin'))) {
    if ($userPath -notlike "*$p*") { $userPath = "$userPath;$p" }
}
[Environment]::SetEnvironmentVariable('Path', $userPath, 'User')

# local.properties + gradle wrapper for the engine project
$proj = Join-Path $PSScriptRoot '..\mobile\android'
"sdk.dir=" + ($sdk -replace '\\', '\\\\') | Out-File (Join-Path $proj 'local.properties') -Encoding ascii
Push-Location $proj
& (Join-Path $gradleHome 'bin\gradle.bat') wrapper --gradle-version 8.11.1 --no-daemon
Pop-Location
Write-Host 'DONE. Build: cd mobile\android; .\gradlew.bat assembleDebug -> app\build\outputs\apk\debug\app-debug.apk'
