FROM ubuntu:22.04

RUN apt-get update -qq && \
    apt-get install -y -qq openssh-server bash && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/sshd

# Create test user with bash shell
RUN useradd -m -s /bin/bash testuser

# Generate SSH key pair
RUN ssh-keygen -t ed25519 -f /test_key -N "" -q

# Set up authorized keys
RUN mkdir -p /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    cp /test_key.pub /home/testuser/.ssh/authorized_keys && \
    chmod 600 /home/testuser/.ssh/authorized_keys && \
    chown -R testuser:testuser /home/testuser/.ssh

# Generate host keys
RUN ssh-keygen -A

# Create test workspace
RUN mkdir -p /workspace && \
    echo "hello world" > /workspace/test.txt && \
    chown -R testuser:testuser /workspace

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
