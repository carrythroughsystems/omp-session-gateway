param($p)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\omp-winqual-' + $p.epoch
$bun = "$root\bun\bun-windows-x64\bun.exe"
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$base = "$env:LOCALAPPDATA\OMP Session Gateway"
$cli = "$root\candidate\apps\gateway\src\cli.js"
$env:PATH = "$root\bun\bun-windows-x64;C:\Program Files\Tailscale;" + $env:PATH
if ($p.ompPath) { $env:PATH = [IO.Path]::GetDirectoryName($p.ompPath) + ';' + $env:PATH }
function Digest($path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
function PrivateDirectory($path) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
# `$step` names a native call the adapter reports on failure: a campaign's `bun.exe exit 1` could not
# say whether install or build failed, and the guest never forwards raw output. `$log`, given only for
# OMP's install and build, keeps that output on the guest, so a retained development VM shows why a
# build failed; it is tooling output from before any host, session or capability exists.
function Run($exe, $arguments, $step = [IO.Path]::GetFileName($exe), $log = $null) {
  # Windows PowerShell 5 treats native stderr as ErrorRecord, even for exit 0.
  # Judge the native exit code, not its choice of output stream.
  $previousPreference = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; $global:LASTEXITCODE = $null; $output = & $exe @arguments 2>&1 }
  finally { $ErrorActionPreference = $previousPreference }
  if ($log) { $output | ForEach-Object { "$_" } | Set-Content -LiteralPath $log -Encoding UTF8 }
  if ($global:LASTEXITCODE -ne 0) { throw ('native command failed: ' + $step + ' exit ' + $global:LASTEXITCODE) }
  $output
}
function Status {
  $text = & $bun $cli status 2>$null
  if (-not $text) { return @{ ready = $false } }
  $text | ConvertFrom-Json
}
function DoctorReport {
  $previousPreference = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; $text = & $bun $cli doctor 2>$null; $code = $global:LASTEXITCODE }
  finally { $ErrorActionPreference = $previousPreference }
  if ($code -notin @(0, 1)) { throw 'doctor execution failed' }
  ($text | Out-String) | ConvertFrom-Json
}
function BackendState {
  # Another Windows user's hold on Tailscale refuses the CLI outright; that reads as no state.
  $previousPreference = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; $text = & $ts status --json 2>$null | Out-String }
  finally { $ErrorActionPreference = $previousPreference }
  try { [string]($text | ConvertFrom-Json).BackendState } catch { '' }
}
function OwnedSessions($account, $names) {
  # A process can exit between enumeration and GetOwner; it then belongs to no one.
  @(Get-CimInstance Win32_Process | Where-Object { $_.SessionId -gt 0 -and $names -contains $_.Name } | Where-Object {
    try { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop).User -eq $account } catch { $false }
  } | ForEach-Object { $_.SessionId } | Sort-Object -Unique)
}
function State {
  $task = Get-ScheduledTask -TaskName 'OMP Session Gateway' -ErrorAction SilentlyContinue
  $logonTrigger = $false; $interactivePrincipal = $false; $logonTriggerScoped = $false
  if ($task) {
    $definition = [xml](Export-ScheduledTask -TaskName 'OMP Session Gateway')
    $triggers = @($definition.Task.Triggers.ChildNodes | Where-Object { $_ -is [Xml.XmlElement] })
    $principals = @($definition.Task.Principals.Principal)
    $logonTrigger = $triggers.Count -eq 1 -and $triggers[0].LocalName -eq 'LogonTrigger' -and $task.Triggers[0].Enabled -eq $true
    $interactivePrincipal = $principals.Count -eq 1 -and $principals[0].LogonType -eq 'InteractiveToken' -and $task.Principal.RunLevel -eq 'Limited'
    # The trigger must name the account the task runs as: without a user it fires on anyone's logon (#294).
    try {
      $sid = { param($name) if ($name -match '^S-1-') { $name } else { ([Security.Principal.NTAccount]$name).Translate([Security.Principal.SecurityIdentifier]).Value } }
      $triggerUser = [string]$task.Triggers[0].UserId
      $logonTriggerScoped = $triggerUser.Length -gt 0 -and (& $sid $triggerUser) -eq (& $sid ([string]$task.Principal.UserId))
    } catch { $logonTriggerScoped = $false }
  }
  $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('OMP Session Gateway\state\') -and $_.CommandLine -match 'cli\.js.+serve' })
  $listeners = @(Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue)
  @{ taskPresent = $null -ne $task; taskRunning = $task.State -eq 'Running'; gatewayProcesses = $procs.Count; listeners = $listeners.Count;
    loopbackOnly = $listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1'; logonTrigger = $logonTrigger; interactivePrincipal = $interactivePrincipal; logonTriggerScoped = $logonTriggerScoped }
}
function Preserved {
  @{ configPreserved = (Digest "$base\config.json") -eq $p.configDigest;
    readinessPreserved = (Digest "$base\readiness-token") -eq $p.credentialDigest }
}
# `install`, `rollback` and `rotate-readiness-token` return once the gateway proves readiness, and on
# a loaded two-vCPU guest `status` has still trailed that proof: one immediate read failed after the
# 2026-09-24 predecessor install and after the 2026-09-29 candidate upgrade, and the next reads passed
# with nothing reinstalled. A read-only status therefore gets a bounded window to settle; the mutation
# before it is never repeated, and a status that never settles fails naming the fields that did not.
$statusSettleSeconds = 60
function Settled([scriptblock]$mismatch) {
  $deadline = [DateTime]::UtcNow.AddSeconds($statusSettleSeconds); $reads = 0
  while ($true) {
    $s = Status; $reads += 1; $failed = & $mismatch $s
    if (-not $failed -or [DateTime]::UtcNow -ge $deadline) { return @{ status = $s; reads = $reads; mismatch = $failed } }
    Start-Sleep -Seconds 2
  }
}
function InstalledMismatch($s, $version) {
  $failed = @()
  if (-not $s.ready) { $failed += 'ready' }
  if (-not $s.installed) { $failed += 'installed' }
  if (-not $s.active) { $failed += 'active' }
  if ($s.diverged) { $failed += 'diverged' }
  if ($s.authMode -ne 'tailscale-serve') { $failed += 'authMode' }
  if ($s.activeVersion -ne $s.serviceVersion) { $failed += 'serviceVersion' }
  if (-not ([string]$s.activeVersion).StartsWith($version + '-')) { $failed += 'activeVersion' }
  $failed -join ','
}
function Installed($version) {
  $settled = Settled { param($s) InstalledMismatch $s $version }
  if ($settled.mismatch) { throw ('status mismatch: ' + $settled.mismatch) }
  $config = Get-Content -Raw "$base\config.json" | ConvertFrom-Json
  if ($config.auth.mode -ne 'tailscale-serve' -or @($config.auth.allowedLogins).Count -ne 1 -or $config.auth.allowedLogins[0] -ne $p.login) { throw 'gateway exact-login allowlist mismatch' }
  $r = Preserved; $r.ready = $true; $r.statusReads = $settled.reads
  # WMI refuses a standard account's network logon, so the Administrator observes its listener.
  if ($p.principal -ne 'standard') {
    if (-not (State).loopbackOnly) { throw 'gateway listener is not loopback-only' }
    $r.loopbackOnly = $true
  }
  $r
}
switch ($p.action) {
  'transport' {
    $os = Get-CimInstance Win32_OperatingSystem
    $hostInfo = Get-CimInstance Win32_ComputerSystem
    if ($os.Caption -notmatch 'Windows Server 2025 Standard' -or $hostInfo.NumberOfLogicalProcessors -ne $p.pins.cpus) { throw 'provider guest shape mismatch' }
    @{ windowsBuild = [int]$os.BuildNumber; cpus = [int]$hostInfo.NumberOfLogicalProcessors; memoryMiB = [int][Math]::Round($hostInfo.TotalPhysicalMemory / 1MB) } | ConvertTo-Json -Compress
  }
  'fingerprint' {
    $binding = Get-CimInstance -Namespace root\cimv2\terminalservices -ClassName Win32_TSGeneralSetting -Filter "TerminalName='RDP-tcp'"
    $cert = Get-ChildItem 'Cert:\LocalMachine\Remote Desktop' | Where-Object { $_.Thumbprint -eq $binding.SSLCertificateSHA1Hash }
    if (@($cert).Count -ne 1) { throw 'active RDP certificate missing' }
    @{ fingerprint = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData))).Replace('-', '').ToLowerInvariant() } | ConvertTo-Json -Compress
  }
  'interactive' {
    if ($p.account) {
      # Another account's disconnected session also has an Explorer; only this account's counts.
      @{ interactive = (OwnedSessions $p.account @('explorer.exe')).Count -gt 0 } | ConvertTo-Json -Compress
    } else {
      @{ interactive = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 }).Count -gt 0 } | ConvertTo-Json -Compress
    }
  }
  'createStandardUser' {
    if ($p.account -notmatch '^ompstd[0-9a-f]{8}$') { throw 'invalid standard account name' }
    if (-not $p.ompPath) { throw 'owned OMP build is absent' }
    $secret = ConvertTo-SecureString $p.accountSecret -AsPlainText -Force
    $user = Get-LocalUser -Name $p.account -ErrorAction SilentlyContinue
    if ($user) { Set-LocalUser -Name $p.account -Password $secret }
    else { $user = New-LocalUser -Name $p.account -Password $secret -PasswordNeverExpires -AccountNeverExpires }
    # Remote Desktop Users, by well-known SID because group names are localized. Never Administrators.
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-555' | Where-Object { $_.SID -eq $user.SID }).Count -eq 0) { Add-LocalGroupMember -SID 'S-1-5-32-555' -Member $user }
    # The lane drives the account through WinRS, which the listener's descriptor governs; Remote
    # Management Users covers only PowerShell endpoints. Read and execute on the listener is the
    # transport, not a privilege: the account's token is asserted separately.
    $descriptor = New-Object Security.AccessControl.CommonSecurityDescriptor($false, $false, (Get-Item WSMan:\localhost\Service\RootSDDL).Value)
    $descriptor.DiscretionaryAcl.AddAccess([Security.AccessControl.AccessControlType]::Allow, $user.SID, -1610612736,
      [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None)
    Set-Item WSMan:\localhost\Service\RootSDDL -Value $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::All) -Force
    # Read and execute on exactly what a fresh install and its doctor run: Bun, the candidate and the
    # pinned OMP build. Everything else in the staging root stays the Administrator's.
    $grantee = '*' + $user.SID.Value
    foreach ($folder in @("$root\bun", "$root\candidate", [IO.Path]::GetDirectoryName($p.ompPath))) { Run icacls.exe @($folder, '/grant', "${grantee}:(OI)(CI)RX") | Out-Null }
    '{"prepared":true}'
  }
  'releaseTailnet' {
    # Tailscale serves one Windows user at a time: another account's CLI is refused while the
    # Administrator holds it unattended or its tray client stays connected. Leave the way a user
    # handing the machine over would: sign out of Windows and Tailscale, which deletes the profile.
    $holders = @('explorer.exe', 'tailscale-ipn.exe')
    foreach ($session in OwnedSessions 'Administrator' $holders) { Run logoff.exe @([string]$session) | Out-Null }
    $deadline = (Get-Date).AddSeconds(90)
    while ((OwnedSessions 'Administrator' $holders).Count -gt 0) { if ((Get-Date) -gt $deadline) { throw 'Administrator desktop did not sign out' }; Start-Sleep -Seconds 3 }
    if ((BackendState) -ne 'NeedsLogin') {
      Run $ts @('serve', 'reset') | Out-Null
      Run $ts @('logout') | Out-Null
    }
    @{ released = (BackendState) -eq 'NeedsLogin' } | ConvertTo-Json -Compress
  }
  'identity' {
    # Evidence from an administrator's token would say nothing about the path this sub-lane tests.
    # whoami lists deny-only groups too, so a UAC-filtered administrator cannot pass as standard.
    if ([Security.Principal.WindowsIdentity]::GetCurrent().Name.Split('\')[-1] -ne $p.account) { throw 'standard action ran under another account' }
    $groups = Run whoami.exe @('/groups', '/fo', 'csv', '/nh') | Out-String
    $privileges = Run whoami.exe @('/priv', '/fo', 'csv', '/nh') | Out-String
    @{ standardUserNonAdmin = -not $groups.Contains('"S-1-5-32-544"'); standardUserNoSecurityPrivilege = -not $privileges.Contains('"SeSecurityPrivilege"') } | ConvertTo-Json -Compress
  }
  'stage' {
    PrivateDirectory $root
    foreach ($folder in @('bun', 'candidate', 'predecessor', 'source', 'native', 'omp-winqual-fixture')) { PrivateDirectory "$root\$folder" }
    # The provider's resolver is not part of the subject. On 2026-10-02 the Vultr-assigned resolver answered
    # SERVFAIL for pkgs.tailscale.com, its CloudFront CNAME and login.tailscale.com while github.com
    # resolved, which failed two campaigns at the first download. Every up adapter gets public
    # resolvers before any download, and the names the lane needs are proven before it starts.
    foreach ($adapter in @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notlike '*Tailscale*' })) {
      Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses @('1.1.1.1', '8.8.8.8')
    }
    Clear-DnsClientCache
    foreach ($name in @('github.com', 'pkgs.tailscale.com', 'registry.npmjs.org', 'login.tailscale.com')) {
      try { Resolve-DnsName $name -Type A -DnsOnly -ErrorAction Stop | Out-Null } catch { throw ('name resolution failed: ' + $name) }
    }
    $downloads = @(
      @{ url = "https://github.com/oven-sh/bun/releases/download/bun-v$($p.pins.bunVersion)/bun-windows-x64.zip"; file = 'bun.zip'; digest = $p.pins.bunSha256 },
      @{ url = "https://pkgs.tailscale.com/stable/tailscale-setup-$($p.pins.tailscaleVersion)-amd64.msi"; file = 'tailscale.msi'; digest = $p.pins.tailscaleSha256 },
      @{ url = "https://registry.npmjs.org/@oh-my-pi/pi-natives-win32-x64/-/pi-natives-win32-x64-$($p.pins.omp.version).tgz"; file = 'native.tgz'; digest = $p.pins.omp.nativeTarballSha256 }
    )
    foreach ($d in $downloads) {
      if (-not (Test-Path "$root\$($d.file)") -or (Digest "$root\$($d.file)") -ne $d.digest) {
        # github.com release downloads intermittently answer 504; retry the pinned download a bounded number of times.
        for ($attempt = 1; ; $attempt++) {
          try { Invoke-WebRequest -UseBasicParsing -Uri $d.url -OutFile "$root\$($d.file)"; break }
          catch { if ($attempt -ge 5) { throw }; Start-Sleep -Seconds 10 }
        }
      }
      if ((Digest "$root\$($d.file)") -ne $d.digest) { throw 'toolchain archive digest mismatch' }
    }
    Expand-Archive -LiteralPath "$root\bun.zip" -DestinationPath "$root\bun" -Force
    if ((Run $bun @('--version')).Trim() -ne $p.pins.bunVersion) { throw 'Bun version mismatch' }
    $signature = Get-AuthenticodeSignature "$root\tailscale.msi"
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch ('CN=' + [regex]::Escape($p.pins.tailscalePublisher) + '(,|$)')) { throw 'Tailscale Authenticode mismatch' }
    if (-not (Test-Path $ts)) {
      $installer = Start-Process msiexec.exe -ArgumentList @('/i', "$root\tailscale.msi", '/qn', '/norestart') -Wait -PassThru
      if ($installer.ExitCode -ne 0) { throw 'Tailscale install failed' }
    }
    $installedVersion = (Run $ts @('version') | Out-String).Trim().Split([char]10)[0].Trim()
    if ($installedVersion -ne $p.pins.tailscaleVersion) { throw 'installed Tailscale version mismatch' }
    Run tar.exe @('-xzf', "$root\native.tgz", '-C', "$root\native") | Out-Null
    if ((Digest "$root\native\package\$($p.pins.omp.nativeFile)") -ne $p.pins.omp.nativeBinarySha256) { throw 'OMP native digest mismatch' }
    @{ staged = $true } | ConvertTo-Json -Compress
  }
  'unpack' {
    foreach ($role in @('candidate', 'predecessor', 'source')) {
      if ((Digest "$root\$role.tar") -ne $p.$role) { throw 'uploaded archive digest mismatch' }
      Run tar.exe @('-xf', "$root\$role.tar", '-C', "$root\$role", '--strip-components', '1') | Out-Null
    }
    @{ unpacked = $true } | ConvertTo-Json -Compress
  }
  'join' {
    # The standard account cannot write to the Administrator's staging root, so its key stays in its own profile.
    $keyPath = if ($p.principal -eq 'standard') { Join-Path $env:LOCALAPPDATA "omp-winqual-$($p.epoch).key" } else { "$root\join.key" }
    $status = (& $ts status --json 2>$null | Out-String) | ConvertFrom-Json
    if ($status.BackendState -ne 'Running') {
      try {
        [IO.File]::WriteAllText($keyPath, $p.joinValue, (New-Object Text.UTF8Encoding($false)))
        Run $ts @('up', "--auth-key=file:$keyPath", "--hostname=omp-winqual-$($p.epoch)", '--accept-dns=true', '--ssh=false', '--unattended=true', '--timeout=120s') | Out-Null
      } finally { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }
    }
    $status = (Run $ts @('status', '--json') | Out-String) | ConvertFrom-Json
    if ($status.BackendState -ne 'Running' -or $status.Self.Tags -notcontains 'tag:omp-session-gateway') { throw 'tagged Tailscale join failed' }

    # The interface table, as the gateway's doctor reads it: CIM refuses a standard account's network logon.
    $tun = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.Description -match 'Tailscale' -and $_.OperationalStatus -eq 'Up' }).Count -gt 0
    if (-not $tun) { throw 'TUN adapter is not up' }
    Run $ts @('serve', '--bg', '--https=443', 'http://127.0.0.1:4317') | Out-Null
    $serve = (Run $ts @('serve', 'status', '--json') | Out-String) | ConvertFrom-Json
    $serveHost = $status.Self.DNSName.TrimEnd('.') + ':443'
    if ($serve.Web.$serveHost.Handlers.'/'.Proxy -ne 'http://127.0.0.1:4317' -or -not $serve.TCP.'443'.HTTPS) { throw 'Serve mapping mismatch' }
    if (($serve.AllowFunnel.PSObject.Properties | Where-Object { $_.Value -eq $true }).Count -gt 0) { throw 'Funnel enabled' }
    @{ origin = 'https://' + $status.Self.DNSName.TrimEnd('.'); machine = $status.Self.ID; taggedNode = $true; tunMode = $tun; funnelOff = $true } | ConvertTo-Json -Compress
  }
  'build' {
    Push-Location "$root\source"
    try {
      Run $bun @('install', '--frozen-lockfile') 'bun-install' "$root\bun-install.log" | Out-Null
      Copy-Item "$root\native\package\$($p.pins.omp.nativeFile)" "$root\source\packages\natives\native\$($p.pins.omp.nativeFile)"
      if ((Digest "$root\source\packages\natives\native\$($p.pins.omp.nativeFile)") -ne $p.pins.omp.nativeBinarySha256) { throw 'staged native mismatch' }
      Run $bun @('--cwd=packages/coding-agent', 'run', 'build') 'omp-build' "$root\omp-build.log" | Out-Null
    } finally { Pop-Location }
    $omp = "$root\source\packages\coding-agent\dist\omp.exe"
    if (-not (Test-Path $omp)) { $omp = "$root\source\packages\coding-agent\dist\omp" }
    if ((Run $omp @('--version') | Out-String).Trim() -ne ('omp/' + $p.pins.omp.version)) { throw 'built OMP version mismatch' }
    # The compiled binary's `config set` can exit 0 without writing anything: over WinRM on a fresh
    # profile it did so twice in one development run, the host then started with auto-start off, and
    # it never published. Write OMP's settings contract directly; the host binary must read it back.
    $settings = "$env:USERPROFILE\.omp\agent"
    New-Item -ItemType Directory -Force -Path $settings | Out-Null
    [IO.File]::WriteAllText("$settings\config.yml", "collab:`n  autoStart: control`n", (New-Object Text.UTF8Encoding($false)))
    if (((Run $omp @('config', 'get', 'collab.autoStart', '--json') | Out-String) | ConvertFrom-Json).value -ne 'control') { throw 'collab.autoStart does not read back as control' }
    @{ ompPath = $omp; binarySha256 = Digest $omp } | ConvertTo-Json -Compress
  }
  'installPredecessor' {
    Run $bun @("$root\predecessor\apps\gateway\src\cli.js", 'install', '--origin', $p.origin, '--allow', $p.login) | Out-Null
    $settled = Settled { param($s) if (-not ($s.ready -and ([string]$s.activeVersion).StartsWith($p.previousVersion + '-'))) { 'ready' } }
    @{ ready = -not $settled.mismatch; statusReads = $settled.reads; configDigest = Digest "$base\config.json"; credentialDigest = Digest "$base\readiness-token" } | ConvertTo-Json -Compress
  }
  'inspectPredecessor' { Installed $p.previousVersion | ConvertTo-Json -Compress }
  'installFresh' {
    Run $bun @($cli, 'install', '--origin', $p.origin, '--allow', $p.login) | Out-Null
    $r = Installed $p.candidateVersion
    @{ ready = $r.ready; statusReads = $r.statusReads; configDigest = Digest "$base\config.json"; credentialDigest = Digest "$base\readiness-token" } | ConvertTo-Json -Compress
  }
  { $_ -in 'upgrade', 'restore' } {
    Run $bun @($cli, 'install', '--origin', $p.origin, '--allow', $p.login) | Out-Null
    $r = Installed $p.candidateVersion; $r.restored = $_ -eq 'restore'; $r | ConvertTo-Json -Compress
  }
  'doctor' {
    $doctor = DoctorReport
    $r = @{ checks = $doctor.checks }
    if ($p.principal -ne 'standard') {
      $state = State
      $r.loopbackOnly = $state.loopbackOnly; $r.logonTrigger = $state.logonTrigger; $r.interactivePrincipal = $state.interactivePrincipal; $r.logonTriggerScoped = $state.logonTriggerScoped
    }
    $r | ConvertTo-Json -Compress -Depth 4
  }
  'reboot' { Run shutdown.exe @('/r', '/t', '3', '/f') | Out-Null; '{"requested":true}' }
  { $_ -in 'prelogin', 'state' } { State | ConvertTo-Json -Compress }
  'ready' {
    $status = Status
    $observed = @{ statusReady = [bool]$status.ready; tailscaleConnected = $false; loopbackTrustSound = $false }
    if ($p.principal -ne 'standard') {
      $task = State
      $observed.taskRunning = [bool]$task.taskRunning; $observed.gatewayProcesses = $task.gatewayProcesses; $observed.listeners = $task.listeners
    }
    if ($status.ready) {
      # HMAC readiness can precede the Windows TUN adapter after logon. Reuse the
      # artifact's real doctor rather than inventing a weaker network predicate.
      $doctor = DoctorReport
      $observed.tailscaleConnected = [bool]$doctor.checks.tailscaleConnected; $observed.loopbackTrustSound = [bool]$doctor.checks.loopbackTrustSound
    }
    $observed.ready = $observed.statusReady -and $observed.tailscaleConnected -and $observed.loopbackTrustSound
    $observed.tunMode = $observed.loopbackTrustSound
    $observed | ConvertTo-Json -Compress
  }
  'startOmp' {
    # WinRS closes its process job at disconnect. An owned Interactive task places the
    # hidden OMP console in the RDP session instead; this is NOT the gateway task.
    $launcherPath = "$root\omp-start.ps1"
    $pidPath = "$root\omp.pid"
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcherPath + '"'
    $taskName = 'OMP Winqual ' + $p.epoch
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      if (@($task.Actions).Count -ne 1 -or $task.Actions.Execute -ne 'powershell.exe' -or $task.Actions.Arguments -ne $arguments) { throw 'owned OMP task changed' }
      if (Test-Path $pidPath) {
        $ownedPid = [int](Get-Content -Raw $pidPath)
        if ($ownedPid -le 0) { throw 'owned OMP PID is invalid' }
        $ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid"
        if ($ownedProcess) {
          if ($ownedProcess.ExecutablePath -ne $p.ompPath) { throw 'owned OMP PID was reused' }
          @{ ompPid = $ownedPid } | ConvertTo-Json -Compress
          break
        }
      }
      if ($task.State -ne 'Running') {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        $task = $null
      }
    }
    # windowsHostScript writes its PID to Console.Out, not the PowerShell pipeline.
    $launcher = @(
      '$priorOut = [Console]::Out; $writer = New-Object IO.StringWriter'
      'try { [Console]::SetOut($writer)'
      ('& { ' + $p.launcher + ' }')
      '$ownedId = 0; if (-not [int]::TryParse($writer.ToString(), [ref]$ownedId) -or $ownedId -le 0) { throw "invalid OMP launcher PID" }'
      ('[IO.File]::WriteAllText(' + "'$pidPath'" + ', [string]$ownedId)')
      '} finally { [Console]::SetOut($priorOut); $writer.Dispose() }'
    ) -join "`n"
    if (-not $task) {
      [IO.File]::WriteAllText($launcherPath, $launcher, (New-Object Text.UTF8Encoding($false)))
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
      $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
      Start-ScheduledTask -TaskName $taskName
    }
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path $pidPath)) { if ((Get-Date) -gt $deadline) { throw 'owned OMP start timed out' }; Start-Sleep -Seconds 1 }
    $ownedPid = [int](Get-Content -Raw $pidPath)
    if ($ownedPid -le 0) { throw 'owned OMP PID is invalid' }
    @{ ompPid = $ownedPid } | ConvertTo-Json -Compress
  }
  'publication' {
    $entries = @(Get-ChildItem "$env:USERPROFILE\.omp\run\collab-hosts\*.json" -ErrorAction SilentlyContinue)
    $owned = @($entries | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json } | Where-Object { $_.pid -eq $p.ompPid })
    @{ namedPipe = $owned.Count -eq 1 -and $owned[0].endpoint.StartsWith('\\.\pipe\') } | ConvertTo-Json -Compress
  }
  'stopOmp' {
    $taskName = 'OMP Winqual ' + $p.epoch
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + "$root\omp-start.ps1" + '"'
      if (@($task.Actions).Count -ne 1 -or $task.Actions.Execute -ne 'powershell.exe' -or $task.Actions.Arguments -ne $arguments) { throw 'owned OMP task changed' }
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    if (-not $p.ompPid -and (Test-Path "$root\omp.pid")) { $p | Add-Member -Force -NotePropertyName ompPid -NotePropertyValue ([int](Get-Content -Raw "$root\omp.pid")) }
    if ($p.ompPid) {
      if ($p.ompPid -le 0) { throw 'owned OMP PID is invalid' }
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ompPid)"
      # The lane reboots its guest, and Windows then reuses process IDs: a stored ID that now names
      # another executable means the owned OMP has already exited, and that process is left alone.
      if ($process -and $process.ExecutablePath -eq $p.ompPath) {
        Run taskkill.exe @('/PID', [string]$p.ompPid, '/T', '/F') | Out-Null
      }
    }
    if (Test-Path "$root\omp.pid") {
      if ($p.ompPid -le 0 -or [int](Get-Content -Raw "$root\omp.pid") -ne $p.ompPid) { throw 'owned OMP PID changed during stop' }
      Remove-Item -LiteralPath "$root\omp.pid" -Force
    }
    '{"stopped":true}'
  }
  'rotate' {
    Run $bun @($cli, 'rotate-readiness-token') | Out-Null
    $settled = Settled { param($s) if (-not $s.ready) { 'ready' } }
    $r = Preserved; $r.readinessChanged = -not $r.readinessPreserved; $r.credentialDigest = Digest "$base\readiness-token"; $r.ready = -not $settled.mismatch; $r.statusReads = $settled.reads; $r | ConvertTo-Json -Compress
  }
  'rollback' {
    $history = Get-Content -Raw "$base\state\installation\history.json" | ConvertFrom-Json
    $to = @($history.activations | Where-Object { $_.StartsWith($p.previousVersion + '-') })[-1]
    if (-not $to) { throw 'predecessor missing from activation history' }
    Run $bun @($cli, 'rollback', '--to', $to) | Out-Null
    $r = Installed $p.previousVersion; $r.historySelected = $true; $r | ConvertTo-Json -Compress
  }
  'uninstall' {
    if (Test-Path $cli) { Run $bun @($cli, 'uninstall') | Out-Null }
    $r = @{}
    if ($p.principal -ne 'standard') { $state = State; $r.uninstalled = -not $state.taskPresent -and $state.gatewayProcesses -eq 0 -and $state.listeners -eq 0 }
    if ($p.configDigest) { $preserved = Preserved; $r.configPreserved = $preserved.configPreserved; $r.readinessPreserved = $preserved.readinessPreserved }
    $r | ConvertTo-Json -Compress
  }
  'resetServe' {
    if (Test-Path $ts) {
      $status = (Run $ts @('status', '--json') | Out-String) | ConvertFrom-Json
      if ($status.BackendState -eq 'Running') { Run $ts @('serve', 'reset') | Out-Null }
    }
    '{"reset":true}'
  }
  'logout' {
    if (Test-Path $ts) {
      $status = (Run $ts @('status', '--json') | Out-String) | ConvertFrom-Json
      if ($status.BackendState -ne 'NeedsLogin') { Run $ts @('logout') | Out-Null }
    }
    '{"loggedOut":true}'
  }
  default { throw 'unknown qualification action' }
}
