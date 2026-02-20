# CRLF Handling Policy

> Spec for line-ending preservation in remote file operations.
> Blocks: RemoteEditOps implementation.

## Core Rule

**Preserve exact bytes from `readFile()` through edit and back to `writeFile()`.
Do not normalize line endings. Ever.**

The remote file's line endings are authoritative. pi-tramp does not convert between
LF and CRLF in any direction.

## The Problem

1. Remote Windows file has CRLF (`\r\n`) line endings.
2. `readFile()` returns the raw bytes, including `\r\n`.
3. `toString("utf8")` preserves the `\r\n` in the string.
4. Pi's LLM generates `oldText` with LF-only (`\n`) — the LLM doesn't see or think
   about line endings.
5. Exact string match of `oldText` against file content fails.
6. Edit appears to succeed (no crash) but nothing changes, or returns "not found."

## Solution: Normalize oldText for Matching, Preserve File Bytes

### Edit Algorithm

```typescript
async applyEdit(path: string, oldText: string, newText: string): Promise<void> {
  // 1. Read the file — raw bytes
  const rawBytes = await this.transport.readFile(path);

  // 2. Enforce size limit
  if (rawBytes.length > 10 * 1024 * 1024) {
    throw new RemoteOperationError(
      `File too large for remote edit: ${path} (${rawBytes.length} bytes, limit 10MB)`,
      { kind: "file_too_large" }
    );
  }

  // 3. Decode to string — preserves exact line endings
  const content = rawBytes.toString("utf8");

  // 4. Detect file's line ending style
  const lineEnding = detectLineEnding(content);

  // 5. Normalize oldText and newText to match file's line ending
  const normalizedOldText = normalizeToLineEnding(oldText, lineEnding);
  const normalizedNewText = normalizeToLineEnding(newText, lineEnding);

  // 6. Attempt exact match with normalized oldText
  const index = content.indexOf(normalizedOldText);

  if (index === -1) {
    // 7. Match failed — provide helpful error
    throw new RemoteOperationError(
      `old_text not found in ${path} on target '${this.targetName}'` +
      (lineEnding === "crlf"
        ? " (note: file uses CRLF line endings)"
        : ""),
      { kind: "command_failed", code: 1, stderr: "old_text not found" }
    );
  }

  // 8. Apply replacement — preserve file's bytes exactly except for the edit
  const newContent = content.slice(0, index) +
    normalizedNewText +
    content.slice(index + normalizedOldText.length);

  // 9. Write back
  await this.transport.writeFile(path, Buffer.from(newContent, "utf8"));
}
```

### Line Ending Detection

```typescript
type LineEnding = "lf" | "crlf" | "mixed" | "none";

function detectLineEnding(content: string): LineEnding {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;

  if (crlfCount === 0 && lfCount === 0) return "none";
  if (crlfCount > 0 && lfCount === 0) return "crlf";
  if (crlfCount === 0 && lfCount > 0) return "lf";
  return "mixed"; // Both present — preserve as-is, don't normalize
}
```

### Line Ending Normalization

```typescript
function normalizeToLineEnding(text: string, lineEnding: LineEnding): string {
  if (lineEnding === "none" || lineEnding === "mixed") {
    // Don't normalize — use the text as provided
    return text;
  }

  // First, normalize to LF
  const lfText = text.replace(/\r\n/g, "\n");

  if (lineEnding === "crlf") {
    // Convert to CRLF
    return lfText.replace(/\n/g, "\r\n");
  }

  // LF — already normalized
  return lfText;
}
```

### Mixed Line Endings

If a file has mixed line endings (some CRLF, some LF):
- **Do not normalize** `oldText` — require an exact match.
- This is an edge case that means the file is already inconsistent.
- The error message should say: "old_text not found (file has mixed line endings — exact match required)."

## Read and Write Operations

### readFile

Return raw bytes. No line-ending transformation. Period.

```typescript
async readFile(path: string): Promise<Buffer> {
  return this.transport.readFile(path);
}
```

### writeFile

Write raw bytes. No line-ending transformation. Period.

```typescript
async writeFile(path: string, content: Buffer): Promise<void> {
  await this.transport.writeFile(path, content);
}
```

The caller (LLM tool) provides content as-is. If the LLM sends LF content to a Windows
target, the file will have LF endings. This is the LLM's responsibility, informed by
the system prompt which tells it the target platform.

## Encoding

- **All text operations use UTF-8.** This is the only encoding supported in Phase 1.
- **No BOM handling.** If a file has a UTF-8 BOM (`EF BB BF`), it's preserved as raw bytes.
  The BOM will be present in the string after `toString("utf8")` and written back unchanged.
  Document as known limitation.
- **Binary files** are transferred as base64 via the transport's `readFile`/`writeFile`.
  Line endings in binary files are irrelevant — they're byte-for-byte preserved.

## Error Messages

| Situation | Message |
|-----------|---------|
| oldText not found, file is LF | `old_text not found in /path/file on target 'dev'` |
| oldText not found, file is CRLF | `old_text not found in /path/file on target 'dev' (note: file uses CRLF line endings)` |
| oldText not found, file is mixed | `old_text not found in /path/file on target 'dev' (file has mixed line endings — exact match required)` |
| File too large | `File too large for remote edit: /path/file (15728640 bytes, limit 10MB)` |

## Summary

| Operation | Line ending handling |
|-----------|---------------------|
| readFile | Raw bytes, no transformation |
| writeFile | Raw bytes, no transformation |
| edit (oldText match) | Normalize oldText to match file's line ending style |
| edit (newText replacement) | Normalize newText to match file's line ending style |
| edit (result) | File retains its original line ending style |
