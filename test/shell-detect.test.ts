import { describe, it, expect } from "vitest";
import { parseShellName, parsePlatform, parseArch, parsePwshVersion, parseShellPolyglot } from "../src/transport/shell-detect.js";

describe("parseShellName", () => {
  it("parses bash", () => {
    expect(parseShellName("bash")).toBe("bash");
    expect(parseShellName("-bash")).toBe("bash");
    expect(parseShellName("/bin/bash")).toBe("bash");
    expect(parseShellName("/usr/bin/bash")).toBe("bash");
  });

  it("parses sh/dash/ash", () => {
    expect(parseShellName("sh")).toBe("sh");
    expect(parseShellName("-sh")).toBe("sh");
    expect(parseShellName("/bin/sh")).toBe("sh");
    expect(parseShellName("dash")).toBe("sh");
    expect(parseShellName("/bin/dash")).toBe("sh");
    expect(parseShellName("ash")).toBe("sh");
    expect(parseShellName("/bin/ash")).toBe("sh");
  });

  it("treats zsh as bash", () => {
    expect(parseShellName("zsh")).toBe("bash");
    expect(parseShellName("-zsh")).toBe("bash");
    expect(parseShellName("/bin/zsh")).toBe("bash");
  });

  it("parses pwsh", () => {
    expect(parseShellName("pwsh")).toBe("pwsh");
    expect(parseShellName("powershell")).toBe("pwsh");
  });

  it("parses cmd", () => {
    expect(parseShellName("cmd")).toBe("cmd");
    expect(parseShellName("cmd.exe")).toBe("cmd");
  });

  it("parses Windows-style paths (backslash separators)", () => {
    expect(parseShellName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
    expect(parseShellName("C:\\Windows\\System32\\bash.exe")).toBe("bash");
    expect(parseShellName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(parseShellName("C:\\pwsh\\pwsh.exe")).toBe("pwsh");
  });

  it("strips .exe suffix on Windows paths", () => {
    expect(parseShellName("/usr/bin/bash")).toBe("bash");
    expect(parseShellName("C:\\pwsh\\pwsh.exe")).toBe("pwsh");
    expect(parseShellName("powershell.exe")).toBe("pwsh");
  });

  it("strips ANSI escape codes", () => {
    expect(parseShellName("\x1b[32mbash\x1b[0m")).toBe("bash");
    expect(parseShellName("\x1b[1m/bin/bash\x1b[0m")).toBe("bash");
  });

  it("returns unknown for unrecognized", () => {
    expect(parseShellName("fish")).toBe("unknown");
    expect(parseShellName("")).toBe("unknown");
  });

  it("handles whitespace", () => {
    expect(parseShellName("  bash\n")).toBe("bash");
  });
});

describe("parsePlatform", () => {
  it("parses Linux", () => {
    expect(parsePlatform("Linux")).toBe("linux");
  });

  it("parses Darwin", () => {
    expect(parsePlatform("Darwin")).toBe("darwin");
  });

  it("parses Windows variants", () => {
    expect(parsePlatform("MINGW64_NT-10.0")).toBe("windows");
    expect(parsePlatform("MSYS_NT-10.0")).toBe("windows");
    expect(parsePlatform("CYGWIN_NT-10.0")).toBe("windows");
    expect(parsePlatform("windows")).toBe("windows");
    expect(parsePlatform("Windows_NT")).toBe("windows");
    expect(parsePlatform("Windows_NT 10.0")).toBe("windows");
    expect(parsePlatform("Windows")).toBe("windows");
  });

  it("strips ANSI escape codes", () => {
    expect(parsePlatform("\x1b[32mLinux\x1b[0m")).toBe("linux");
    expect(parsePlatform("\x1b[1mDarwin\x1b[0m")).toBe("darwin");
  });

  it("returns unknown for unrecognized", () => {
    expect(parsePlatform("FreeBSD")).toBe("unknown");
  });
});

describe("parseArch", () => {
  it("normalizes common architectures", () => {
    expect(parseArch("x86_64")).toBe("x86_64");
    expect(parseArch("aarch64")).toBe("aarch64");
    expect(parseArch("arm64")).toBe("aarch64"); // macOS normalization
    expect(parseArch("armv7l")).toBe("armv7l");
  });

  it("handles empty", () => {
    expect(parseArch("")).toBe("unknown");
  });

  it("strips ANSI escape codes", () => {
    expect(parseArch("\x1b[32mx86_64\x1b[0m")).toBe("x86_64");
  });

  it("rejects absurdly long values", () => {
    expect(parseArch("a".repeat(1000))).toBe("unknown");
  });
});

describe("parsePwshVersion", () => {
  it("parses version numbers", () => {
    expect(parsePwshVersion("7")).toBe(7);
    expect(parsePwshVersion("5")).toBe(5);
    expect(parsePwshVersion("  7\n")).toBe(7);
  });

  it("rejects garbage suffixes (parseInt would accept these)", () => {
    expect(parsePwshVersion("7junk")).toBeNull();
    expect(parsePwshVersion("5.1")).toBeNull();
    expect(parsePwshVersion("7 extra")).toBeNull();
  });

  it("rejects zero and negative", () => {
    expect(parsePwshVersion("0")).toBeNull();
    expect(parsePwshVersion("-1")).toBeNull();
  });

  it("returns null for non-numbers", () => {
    expect(parsePwshVersion("")).toBeNull();
    expect(parsePwshVersion("error")).toBeNull();
    expect(parsePwshVersion(".PSVersion.Major")).toBeNull();
  });

  it("strips ANSI escape codes", () => {
    expect(parsePwshVersion("\x1b[32m7\x1b[0m")).toBe(7);
  });
});

describe("parseShellPolyglot", () => {
  it("detects cmd.exe", () => {
    expect(parseShellPolyglot("CMD")).toBe("cmd");
    expect(parseShellPolyglot("CMD\r\n")).toBe("cmd");
  });

  it("detects PowerShell Core (pwsh 7)", () => {
    expect(parseShellPolyglot("Core")).toBe("pwsh");
    expect(parseShellPolyglot("Core\r\n")).toBe("pwsh");
  });

  it("detects Windows PowerShell (Desktop)", () => {
    expect(parseShellPolyglot("Desktop")).toBe("pwsh");
  });

  it("returns unknown for bash/unrecognized output", () => {
    expect(parseShellPolyglot("bash: syntax error")).toBe("unknown");
    expect(parseShellPolyglot("")).toBe("unknown");
  });

  it("strips ANSI codes", () => {
    expect(parseShellPolyglot("\x1b[32mCore\x1b[0m")).toBe("pwsh");
  });
});
