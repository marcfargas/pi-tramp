# escape=`
# Windows Server Core with OpenSSH + pwsh 7 + bash (Git for Windows).
# Mirrors the Linux test container: SSH key auth, test user, /workspace equivalent.
#
# Build: docker build -t pi-tramp-win-test test/fixtures/windows-ssh-server/
# Run:   docker run -d --name pi-tramp-win-test -p 2222:22 pi-tramp-win-test

FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

# ---------------------------------------------------------------------------
# Install PowerShell 7 (zip — no MSI needed)
# ---------------------------------------------------------------------------
RUN $v = '7.4.7'; `
    Invoke-WebRequest `
      "https://github.com/PowerShell/PowerShell/releases/download/v$v/PowerShell-$v-win-x64.zip" `
      -OutFile C:\pwsh.zip; `
    Expand-Archive C:\pwsh.zip -DestinationPath 'C:\pwsh'; `
    Remove-Item C:\pwsh.zip; `
    [Environment]::SetEnvironmentVariable('PATH', $env:PATH + ';C:\pwsh', 'Machine')

# ---------------------------------------------------------------------------
# Install Git for Windows — FULL install (provides bash, sh, base64, coreutils).
# MinGit lacks base64/coreutils which our BashDriver requires.
# ---------------------------------------------------------------------------
RUN $v = '2.47.1'; $p = '2'; `
    Invoke-WebRequest `
      "https://github.com/git-for-windows/git/releases/download/v$v.windows.$p/Git-$v.$p-64-bit.exe" `
      -OutFile C:\git-installer.exe; `
    Start-Process C:\git-installer.exe -Wait -NoNewWindow -ArgumentList `
      '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/DIR=C:\git'; `
    Remove-Item C:\git-installer.exe; `
    [Environment]::SetEnvironmentVariable('PATH', $env:PATH + ';C:\git\cmd;C:\git\usr\bin;C:\git\mingw64\bin', 'Machine')

# ---------------------------------------------------------------------------
# Install OpenSSH Server
# ---------------------------------------------------------------------------
RUN Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null; `
    Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null

# Set default SSH shell to pwsh 7 (not Windows PowerShell 5.1)
RUN New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' `
      -Name DefaultShell -Value 'C:\pwsh\pwsh.exe' `
      -PropertyType String -Force | Out-Null

# ---------------------------------------------------------------------------
# Create test user with SSH key auth
# ---------------------------------------------------------------------------
RUN net user testuser 'TestPass123!' /add | Out-Null; `
    net localgroup Administrators testuser /add | Out-Null

# Generate ed25519 SSH key pair (empty passphrase).
# Switch SHELL to cmd — PowerShell mangles empty string args to native commands,
# even through cmd /c. Direct cmd SHELL is the only reliable way.
SHELL ["cmd", "/S", "/C"]
RUN ssh-keygen -t ed25519 -f C:\test_key -N "" -q
SHELL ["powershell", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

# Authorized keys for testuser (regular user path)
RUN New-Item -ItemType Directory -Path C:\Users\testuser\.ssh -Force | Out-Null; `
    Copy-Item C:\test_key.pub C:\Users\testuser\.ssh\authorized_keys

# Authorized keys for administrators (Windows OpenSSH reads from ProgramData)
RUN Copy-Item C:\test_key.pub C:\ProgramData\ssh\administrators_authorized_keys

# Fix permissions — Windows OpenSSH is strict about authorized_keys ACLs
RUN @('C:\Users\testuser\.ssh\authorized_keys', 'C:\ProgramData\ssh\administrators_authorized_keys') | ForEach-Object { `
      $acl = Get-Acl $_; `
      $acl.SetAccessRuleProtection($true, $false); `
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','Allow'))); `
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Administrators','FullControl','Allow'))); `
      Set-Acl $_ $acl }

# Generate default sshd_config by starting then stopping sshd.
# Modify it to ensure key auth and disable strict modes for test environment.
RUN Start-Service sshd; Stop-Service sshd; `
    if (Test-Path C:\ProgramData\ssh\sshd_config) { `
      (Get-Content C:\ProgramData\ssh\sshd_config) `
        -replace '#PubkeyAuthentication yes','PubkeyAuthentication yes' `
        -replace '#StrictModes yes','StrictModes no' | `
      Set-Content C:\ProgramData\ssh\sshd_config `
    }

# ---------------------------------------------------------------------------
# Test workspace (mirrors Linux container's /workspace)
# ---------------------------------------------------------------------------
RUN New-Item -ItemType Directory -Path C:\workspace -Force | Out-Null; `
    Set-Content -Path C:\workspace\test.txt -Value 'hello world' -NoNewline

EXPOSE 22

# Start sshd and keep container alive
CMD ["powershell", "-Command", "Start-Service sshd; while ($true) { Start-Sleep 3600 }"]
