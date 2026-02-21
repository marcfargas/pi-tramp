FROM ubuntu:22.04

RUN apt-get update -qq && \
    apt-get install -y -qq openssh-server bash wget libicu70 libssl3 && \
    rm -rf /var/lib/apt/lists/*

# Install PowerShell 7 from tarball (works on arm64 + amd64)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then PS_ARCH="x64"; else PS_ARCH="arm64"; fi && \
    PS_VERSION="7.4.7" && \
    wget -q "https://github.com/PowerShell/PowerShell/releases/download/v${PS_VERSION}/powershell-${PS_VERSION}-linux-${PS_ARCH}.tar.gz" \
         -O /tmp/powershell.tar.gz && \
    mkdir -p /opt/microsoft/powershell/7 && \
    tar zxf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 && \
    chmod +x /opt/microsoft/powershell/7/pwsh && \
    ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh && \
    rm /tmp/powershell.tar.gz

RUN mkdir -p /run/sshd

# Create test user with bash shell (default)
RUN useradd -m -s /bin/bash testuser

# Also create a test user with pwsh as login shell
RUN useradd -m -s /usr/bin/pwsh testuser-pwsh

# Generate SSH key pair (shared between both users)
RUN ssh-keygen -t ed25519 -f /test_key -N "" -q

# Set up authorized keys for both users
RUN mkdir -p /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    cp /test_key.pub /home/testuser/.ssh/authorized_keys && \
    chmod 600 /home/testuser/.ssh/authorized_keys && \
    chown -R testuser:testuser /home/testuser/.ssh

RUN mkdir -p /home/testuser-pwsh/.ssh && \
    chmod 700 /home/testuser-pwsh/.ssh && \
    cp /test_key.pub /home/testuser-pwsh/.ssh/authorized_keys && \
    chmod 600 /home/testuser-pwsh/.ssh/authorized_keys && \
    chown -R testuser-pwsh:testuser-pwsh /home/testuser-pwsh/.ssh

# Generate host keys
RUN ssh-keygen -A

# Create test workspace (writable by both users)
RUN mkdir -p /workspace && \
    echo "hello world" > /workspace/test.txt && \
    chmod 777 /workspace

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
