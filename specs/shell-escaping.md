# Shell Escaping Algorithm

> Spec for escaping arguments in BashDriver and PwshDriver.
> Blocks: BashDriver, PwshDriver, all tool overrides.

## Principle

**The ShellDriver is responsible for escaping.** Transports pass raw commands to the shell.
Operations build commands using the ShellDriver's escape methods. No other component escapes.

The escaping goal: take an arbitrary string (file path, content, argument) and produce a
shell-safe string that the shell interprets as a literal value — no expansion, no injection.

## BashDriver.shellEscape(arg: string): string

### Algorithm

```typescript
function shellEscape(arg: string): string {
  // Empty string → ''
  if (arg === "") return "''";

  // If arg contains no special chars, return as-is (optimization)
  if (/^[a-zA-Z0-9._\-\/=:@]+$/.test(arg)) return arg;

  // Strategy: single-quote everything, escape embedded single quotes
  // In bash, single quotes preserve all characters literally except
  // single quote itself. To embed a single quote: end single-quoting,
  // add escaped single quote, restart single-quoting.
  //
  // "it's" → 'it'"'"'s'
  //
  // This works in bash, sh, dash, zsh — all POSIX shells.
  return "'" + arg.replace(/'/g, "'\"'\"'") + "'";
}
```

### Why This Strategy

1. **Single-quoting is the safest shell quoting**: Inside single quotes, `$`, `` ` ``,
   `\`, `!`, and all other special characters are treated literally. No expansion occurs.

2. **POSIX-compatible**: Unlike `$'...'` (ANSI-C quoting), single-quote escaping works
   in dash, sh, bash, zsh, and all POSIX shells. This is critical because SSH targets
   may use `/bin/sh` which is often dash on Debian/Ubuntu.

3. **Handles newlines**: Single quotes preserve literal newlines. No special handling needed.

4. **No `$'...'` dependency**: ANSI-C quoting (`$'\n'`) is bash-only. Since we must support
   dash/sh targets, we avoid it entirely.

### Edge Cases

| Input | Escaped | Notes |
|-------|---------|-------|
| `simple.txt` | `simple.txt` | No special chars, returned as-is |
| `file with spaces.txt` | `'file with spaces.txt'` | Spaces → single-quoted |
| `file's.txt` | `'file'"'"'s.txt'` | Single quote → end-quote, escaped, resume |
| `file"double.txt` | `'file"double.txt'` | Double quotes safe inside single quotes |
| `file$(rm -rf /).txt` | `'file$(rm -rf /).txt'` | Command substitution neutralized |
| `` file`cmd`.txt `` | `` 'file`cmd`.txt' `` | Backtick expansion neutralized |
| `file\nnewline.txt` | `'file\nnewline.txt'` | Literal \n (not actual newline) |
| `file\twith\ttabs.txt` | `'file\twith\ttabs.txt'` | Tabs preserved literally |
| `""` (empty) | `''` | Empty string |
| `$HOME/path` | `'$HOME/path'` | Variable expansion neutralized |
| `path;rm -rf /` | `'path;rm -rf /'` | Command chaining neutralized |
| `path\x00null` | `'path\x00null'` | Null byte: see note below |

### Null Bytes

Null bytes (`\0`) cannot be represented in shell arguments on any shell. If `arg` contains
a null byte, **throw an error** before escaping:

```typescript
if (arg.includes("\0")) {
  throw new Error("Shell argument contains null byte — cannot be safely escaped");
}
```

## PwshDriver.shellEscape(arg: string): string

### Algorithm

```typescript
function shellEscape(arg: string): string {
  // Empty string → ''
  if (arg === "") return "''";

  // If arg contains no special chars, return as-is (optimization)
  if (/^[a-zA-Z0-9._\-\/\\=:@]+$/.test(arg)) return arg;

  // Strategy: single-quote everything, double embedded single quotes.
  // In PowerShell, single quotes are literal strings.
  // To embed a single quote: double it.
  //
  // "it's" → 'it''s'
  return "'" + arg.replace(/'/g, "''") + "'";
}
```

### Why This Strategy

1. **Single quotes in PowerShell are fully literal**: No variable expansion (`$var`),
   no escape processing. Only the single quote itself needs escaping (by doubling).

2. **Works in pwsh 7+ and Windows PowerShell 5.1**: Both versions handle `''` the same way.

3. **Simpler than bash**: PowerShell's single-quote doubling is cleaner than the
   bash end-quote-escape-resume pattern.

### Edge Cases

| Input | Escaped | Notes |
|-------|---------|-------|
| `simple.txt` | `simple.txt` | No special chars |
| `file with spaces.txt` | `'file with spaces.txt'` | Spaces |
| `file's.txt` | `'file''s.txt'` | Single quote doubled |
| `C:\Users\marc` | `C:\Users\marc` | Backslashes safe (no special chars regex allows `\`) |
| `$env:HOME\path` | `'$env:HOME\path'` | Variable expansion neutralized |
| `file;Remove-Item *` | `'file;Remove-Item *'` | Command chaining neutralized |
| `path$(cmd)` | `'path$(cmd)'` | Subexpression neutralized |

### Null Bytes

Same as BashDriver: throw an error if `arg` contains `\0`.

## Complete Command Examples

### readFile (cat via base64)

**Bash:**
```bash
base64 -w 0 '/home/user/my project/file with spaces.txt'
```
Built as:
```typescript
const escaped = bashDriver.shellEscape(absolutePath);
return `base64 -w 0 ${escaped}`;
```

**PowerShell:**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\Users\marc\my project\file''s.txt'))
```
Built as:
```typescript
const escaped = pwshDriver.shellEscape(absolutePath);
return `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${escaped}))`;
```

### writeFile (base64 decode to temp, then move)

**Bash:**
```bash
printf '%s' 'SGVsbG8gV29ybGQ=' | base64 -d > '/tmp/file.abc123.tmp' && mv '/tmp/file.abc123.tmp' '/home/user/my project/output.txt'
```
Built as:
```typescript
const escapedTmp = bashDriver.shellEscape(tmpPath);
const escapedDst = bashDriver.shellEscape(absolutePath);
const escapedB64 = bashDriver.shellEscape(base64Content);
return `printf '%s' ${escapedB64} | base64 -d > ${escapedTmp} && mv ${escapedTmp} ${escapedDst}`;
```

**PowerShell:**
```powershell
[IO.File]::WriteAllBytes('C:\temp\file.abc123.tmp', [Convert]::FromBase64String('SGVsbG8gV29ybGQ=')) ; Move-Item -Force 'C:\temp\file.abc123.tmp' 'C:\Users\marc\output.txt'
```

### mkdir -p

**Bash:**
```bash
mkdir -p '/home/user/new dir/sub dir'
```

**PowerShell:**
```powershell
New-Item -ItemType Directory -Force -Path 'C:\Users\marc\new dir\sub dir' | Out-Null
```

## Testing Requirements

All escaping tests MUST run against real local shells, NOT mocked:

```typescript
async function testBashEscape(input: string): Promise<boolean> {
  const escaped = bashDriver.shellEscape(input);
  // Use echo to verify round-trip: the shell should emit the original string
  const cmd = `printf '%s' ${escaped}`;
  const result = await execInBash(cmd);
  return result === input;
}
```

### Required Test Matrix

| Input | bash | sh/dash | pwsh |
|-------|------|---------|------|
| `simple.txt` | ✓ | ✓ | ✓ |
| `file with spaces.txt` | ✓ | ✓ | ✓ |
| `file's.txt` | ✓ | ✓ | ✓ |
| `file"double.txt` | ✓ | ✓ | ✓ |
| `file$(rm -rf /).txt` | ✓ | ✓ | ✓ |
| `` file`cmd`.txt `` | ✓ | ✓ | ✓ |
| `path with\nnewline` (actual newline) | ✓ | ✓ | ✓ |
| `path\twith\ttabs` (actual tabs) | ✓ | ✓ | ✓ |
| empty string `""` | ✓ | ✓ | ✓ |
| `$HOME/path` | ✓ | ✓ | ✓ |
| `null\x00byte` | ERROR | ERROR | ERROR |

### How to Run

```bash
# bash tests: spawn bash -c
# sh tests: spawn sh -c (dash on Debian/Ubuntu)
# pwsh tests: spawn pwsh -NoProfile -NonInteractive -Command
```

## Escape Responsibility Matrix

| Component | Escapes? | Notes |
|-----------|----------|-------|
| Agent (LLM) | No | Sends raw paths/content |
| Tool override | No | Passes raw params to operations |
| Operations (remote-read, etc.) | **Uses ShellDriver** | Calls `shellEscape()` to build commands |
| ShellDriver | **YES** | The ONLY component that escapes |
| Transport | No | Receives complete, already-escaped commands |
