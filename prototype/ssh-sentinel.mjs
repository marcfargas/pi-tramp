#!/usr/bin/env node

/**
 * SSH Sentinel Protocol Prototype
 *
 * Validates the core assumption: we can multiplex commands over a single
 * persistent SSH connection using UUID-based sentinels to detect command
 * completion and capture exit codes.
 *
 * Usage:
 *   node prototype/ssh-sentinel.mjs [docker|walkman]
 *
 * Prerequisites:
 *   docker: docker run -d --name pi-tramp-ssh-test -p 2222:22 pi-tramp-ssh-test
 *   walkman: SSH keys in Windows agent, walkman in ~/.ssh/config
 */

import { spawn } from "child_process";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const target = process.argv[2] || "docker";

// Always use Windows OpenSSH — it has access to the Windows SSH agent.
// Git Bash's ssh can't see agent keys and would fail on hosts that need them.
const WIN_SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";

// Convert TEMP path to Windows format for -i flag (Windows ssh.exe needs Windows paths)
const TEMP_WIN = process.env.TEMP || process.env.TMP || "C:\\Users\\marc\\AppData\\Local\\Temp";

const TARGETS = {
  docker: {
    // Windows SSH → Docker container (bash)
    // -T: no PTY (we don't want input echo or prompts)
    command: WIN_SSH,
    args: [
      "-i", `${TEMP_WIN}\\pi-tramp-test-key`,
      "-p", "2222",
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=yes",
      "-T",
      "testuser@localhost",
      "bash --norc --noprofile"
    ],
    shell: "bash",
  },
  walkman: {
    // Windows SSH → walkman (pwsh)
    // -T: no PTY
    command: WIN_SSH,
    args: [
      "-T",
      "walkman",
      "powershell -NoProfile -NonInteractive -Command -"
    ],
    shell: "pwsh",
  },
};

const config = TARGETS[target];
if (!config) {
  console.error(`Unknown target: ${target}. Use: docker, walkman`);
  process.exit(1);
}

console.log(`\n=== SSH Sentinel Prototype — target: ${target} (${config.shell}) ===\n`);

// ---------------------------------------------------------------------------
// SSH Connection
// ---------------------------------------------------------------------------

const ssh = spawn(config.command, config.args, {
  stdio: ["pipe", "pipe", "pipe"],
  // For Windows SSH (agent access), don't use shell
  windowsHide: true,
});

let sshReady = false;
let stderrLog = "";

ssh.stderr.on("data", (chunk) => {
  stderrLog += chunk.toString();
});

ssh.on("error", (err) => {
  console.error("SSH spawn error:", err.message);
  process.exit(1);
});

ssh.on("close", (code) => {
  if (!sshReady) {
    console.error("SSH exited before ready. stderr:", stderrLog);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// Sentinel Reader
// ---------------------------------------------------------------------------

let buffer = "";
let outputChunks = [];
let currentSentinelRegex = null;
let currentResolve = null;
let currentReject = null;
let currentTimeout = null;

ssh.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");

  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete last line

  for (const line of lines) {
    const cleaned = line.replace(/\r$/, "");

    if (process.env.DEBUG) console.log(`  [stdout] ${JSON.stringify(cleaned)}`);

    if (currentSentinelRegex) {
      const match = cleaned.match(currentSentinelRegex);
      if (match) {
        const exitCode = parseInt(match[1], 10);
        const stdout = outputChunks.join("\n");

        clearTimeout(currentTimeout);
        const resolve = currentResolve;
        currentResolve = null;
        currentReject = null;
        currentSentinelRegex = null;
        outputChunks = [];

        resolve({ stdout, stderr: "", exitCode });
        return;
      }
    }

    outputChunks.push(cleaned);
  }
});

// ---------------------------------------------------------------------------
// exec() — send command, wait for sentinel
// ---------------------------------------------------------------------------

// Serial queue
let execQueue = Promise.resolve();

function exec(command, timeoutMs = 10000) {
  // Chain on the queue to ensure serial execution
  const p = execQueue.then(() => execRaw(command, timeoutMs));
  execQueue = p.catch(() => {}); // don't let rejections break the chain
  return p;
}

function execRaw(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sentinelId = randomUUID().replace(/-/g, "");
    const sentinel = `__PITRAMP_${sentinelId}__`;

    currentSentinelRegex = new RegExp(`^${sentinel}_(\\d+)$`);
    currentResolve = resolve;
    currentReject = reject;
    outputChunks = [];

    currentTimeout = setTimeout(() => {
      currentSentinelRegex = null;
      currentResolve = null;
      currentReject = null;
      reject(new Error(`Sentinel timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let wrapped;
    if (config.shell === "pwsh") {
      // PowerShell: reset $LASTEXITCODE before each command so it reflects
      // THIS command's native exit code, not a stale value from a prior command.
      // Pure cmdlets leave $LASTEXITCODE at 0 (our reset value), which is correct.
      wrapped = `$global:LASTEXITCODE = 0\n${command}\nWrite-Output "${sentinel}_$LASTEXITCODE"\n`;
    } else {
      // Bash: use printf for sentinel
      wrapped = `${command}\nprintf '%s_%d\\n' '${sentinel}' $?\n`;
    }

    ssh.stdin.write(wrapped);
  });
}

// ---------------------------------------------------------------------------
// Wait for SSH to be ready
// ---------------------------------------------------------------------------

async function waitReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SSH ready timeout")), 15000);

    // Send a probe and wait for the sentinel
    const probeId = randomUUID().replace(/-/g, "");
    const probeSentinel = `__PITRAMP_${probeId}__`;
    const probeRegex = new RegExp(`^${probeSentinel}_(\\d+)$`);

    currentSentinelRegex = probeRegex;
    currentResolve = (result) => {
      clearTimeout(timeout);
      sshReady = true;
      resolve();
    };
    currentReject = reject;
    outputChunks = [];

    currentTimeout = timeout;

    let probeCmd;
    if (config.shell === "pwsh") {
      // Suppress colors: $PSStyle exists in pwsh 7.2+, not in Windows PowerShell 5.1
      // Initialize $LASTEXITCODE to 0 so it's never null in sentinel output
      probeCmd = `try { $PSStyle.OutputRendering = 'PlainText' } catch {}\n$ProgressPreference = 'SilentlyContinue'\n$global:LASTEXITCODE = 0\nWrite-Output "${probeSentinel}_0"\n`;
    } else {
      probeCmd = `printf '%s_%d\\n' '${probeSentinel}' 0\n`;
    }

    ssh.stdin.write(probeCmd);
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, testName, detail) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.log(`  ✗ ${testName}: ${detail}`);
    failed++;
  }
}

async function runTests() {
  console.log("Waiting for SSH connection...");
  await waitReady();
  console.log("Connected!\n");

  // --- Test 1: Basic echo ---
  console.log("Test 1: Basic echo");
  const r1 = await exec(config.shell === "pwsh"
    ? 'Write-Output "hello"'
    : 'echo "hello"'
  );
  assert(r1.stdout.trim() === "hello", "output is 'hello'", `got: '${r1.stdout.trim()}'`);
  assert(r1.exitCode === 0, "exit code is 0", `got: ${r1.exitCode}`);

  // --- Test 2: Exit code propagation ---
  console.log("\nTest 2: Exit code propagation");
  if (config.shell === "pwsh") {
    const r2 = await exec('cmd /c "exit 42"');
    assert(r2.exitCode === 42, "exit code is 42", `got: ${r2.exitCode}`);
  } else {
    // Use (exit 42) in a subshell — don't exit the main shell!
    const r2 = await exec("(exit 42)");
    assert(r2.exitCode === 42, "exit code is 42", `got: ${r2.exitCode}`);
  }

  // --- Test 3: Multi-line output ---
  console.log("\nTest 3: Multi-line output");
  const r3 = await exec(config.shell === "pwsh"
    ? '1..5 | ForEach-Object { Write-Output "line $_" }'
    : 'for i in 1 2 3 4 5; do echo "line $i"; done'
  );
  const lines3 = r3.stdout.trim().split("\n").map(l => l.trim());
  assert(lines3.length === 5, "5 lines of output", `got: ${lines3.length}`);
  assert(lines3[0] === "line 1", "first line correct", `got: '${lines3[0]}'`);
  assert(lines3[4] === "line 5", "last line correct", `got: '${lines3[4]}'`);

  // --- Test 4: Empty output ---
  console.log("\nTest 4: Empty output");
  const r4 = await exec(config.shell === "pwsh"
    ? '$null'
    : 'true'
  );
  assert(r4.stdout.trim() === "", "empty output", `got: '${r4.stdout.trim()}'`);
  assert(r4.exitCode === 0, "exit code 0", `got: ${r4.exitCode}`);

  // --- Test 5: Large output (10,000 lines) ---
  console.log("\nTest 5: Large output (10,000 lines)");
  const r5 = await exec(
    config.shell === "pwsh"
      ? '1..10000 | ForEach-Object { $_ }'
      : 'seq 1 10000',
    30000 // longer timeout for large output
  );
  const lines5 = r5.stdout.trim().split("\n");
  assert(lines5.length === 10000, "10000 lines", `got: ${lines5.length}`);
  assert(lines5[0].trim() === "1", "first line is 1", `got: '${lines5[0].trim()}'`);
  assert(lines5[9999].trim() === "10000", "last line is 10000", `got: '${lines5[9999].trim()}'`);

  // --- Test 6: Sequential commands (serial queue) ---
  console.log("\nTest 6: Sequential commands via serial queue");
  const [ra, rb, rc] = await Promise.all([
    exec(config.shell === "pwsh" ? 'Write-Output "a"' : 'echo "a"'),
    exec(config.shell === "pwsh" ? 'Write-Output "b"' : 'echo "b"'),
    exec(config.shell === "pwsh" ? 'Write-Output "c"' : 'echo "c"'),
  ]);
  assert(ra.stdout.trim() === "a", "first is 'a'", `got: '${ra.stdout.trim()}'`);
  assert(rb.stdout.trim() === "b", "second is 'b'", `got: '${rb.stdout.trim()}'`);
  assert(rc.stdout.trim() === "c", "third is 'c'", `got: '${rc.stdout.trim()}'`);

  // --- Test 7: Special characters in output ---
  console.log("\nTest 7: Special characters in output");
  const r7 = await exec(config.shell === "pwsh"
    ? "Write-Output 'hello $world \"quotes\" `backticks`'"
    : "echo 'hello $world \"quotes\" `backticks`'"
  );
  const out7 = r7.stdout.trim();
  assert(out7.includes("$world"), "dollar sign preserved", `got: '${out7}'`);
  assert(out7.includes('"quotes"'), "double quotes preserved", `got: '${out7}'`);

  // --- Test 8: Binary-like output (base64 round-trip) ---
  console.log("\nTest 8: Base64 round-trip");
  if (config.shell === "pwsh") {
    const r8 = await exec(
      "[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('Hello World from pwsh'))"
    );
    assert(r8.stdout.trim() === "SGVsbG8gV29ybGQgZnJvbSBwd3No", "base64 correct", `got: '${r8.stdout.trim()}'`);
  } else {
    const r8 = await exec("echo -n 'Hello World from bash' | base64");
    assert(r8.stdout.trim() === "SGVsbG8gV29ybGQgZnJvbSBiYXNo", "base64 correct", `got: '${r8.stdout.trim()}'`);
  }

  // --- Test 9: File operations ---
  console.log("\nTest 9: File operations (read/write via shell)");
  if (config.shell === "pwsh") {
    await exec("[IO.File]::WriteAllText('C:\\temp\\pitramp-test.txt', 'sentinel test content')");
    const r9 = await exec("[IO.File]::ReadAllText('C:\\temp\\pitramp-test.txt')");
    assert(r9.stdout.trim() === "sentinel test content", "file content matches", `got: '${r9.stdout.trim()}'`);
    await exec("Remove-Item 'C:\\temp\\pitramp-test.txt' -ErrorAction SilentlyContinue");
  } else {
    await exec("echo 'sentinel test content' > /tmp/pitramp-test.txt");
    const r9 = await exec("cat /tmp/pitramp-test.txt");
    assert(r9.stdout.trim() === "sentinel test content", "file content matches", `got: '${r9.stdout.trim()}'`);
    await exec("rm -f /tmp/pitramp-test.txt");
  }

  // --- Test 10: Rapid fire (20 sequential commands) ---
  console.log("\nTest 10: Rapid fire (20 sequential commands)");
  const rapidResults = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      exec(config.shell === "pwsh"
        ? `Write-Output "rapid_${i}"`
        : `echo "rapid_${i}"`
      )
    )
  );
  let rapidOk = true;
  for (let i = 0; i < 20; i++) {
    if (rapidResults[i].stdout.trim() !== `rapid_${i}`) {
      rapidOk = false;
      console.log(`    Failed at index ${i}: expected 'rapid_${i}', got '${rapidResults[i].stdout.trim()}'`);
    }
  }
  assert(rapidOk, "all 20 rapid commands returned correct output", "see above");

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  // Cleanup
  ssh.stdin.end();
  ssh.kill();

  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runTests().catch((err) => {
  console.error("Fatal error:", err.message);
  if (stderrLog) console.error("SSH stderr:", stderrLog);
  ssh.kill();
  process.exit(1);
});
