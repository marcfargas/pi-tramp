import { describe, it, expect } from "vitest";
import { parseShellName, parsePlatform, parseArch, parsePwshVersion } from "../src/transport/shell-detect.js";

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
});

describe("parsePwshVersion", () => {
  it("parses version numbers", () => {
    expect(parsePwshVersion("7")).toBe(7);
    expect(parsePwshVersion("5")).toBe(5);
  });

  it("returns null for non-numbers", () => {
    expect(parsePwshVersion("")).toBeNull();
    expect(parsePwshVersion("error")).toBeNull();
    expect(parsePwshVersion(".PSVersion.Major")).toBeNull();
  });
});
