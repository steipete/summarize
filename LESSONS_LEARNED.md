# Lessons Learned - Stdin Support Implementation

## Session Date: 2026-02-07
## Feature: Stdin Support for Summarize CLI

---

## Testing Patterns

### Injecting Stdin for Tests
When testing CLI functionality that reads from stdin, always inject the stdin stream through the RunEnv rather than mocking process.stdin globally:

```typescript
// Good: Injected stdin
type RunEnv = {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  execFile?: ExecFileFn
  stdin?: NodeJS.ReadableStream  // Add this
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

// Usage in test:
await runCli(['-'], {
  env: { HOME: home },
  fetch: vi.fn(),
  stdin: createStdinStream('test content'),  // Injected
  stdout: noopStream(),
  stderr: noopStream(),
})
```

### Creating Test Streams
```typescript
const createStdinStream = (content: string): Readable => {
  return Readable.from([content])
}

const noopStream = () =>
  new Writable({
    write(chunk, encoding, callback) {
      void chunk
      void encoding
      callback()
    },
  })
```

---

## Code Review Integration

### CodeRabbit Workflow
1. **Address actionable comments first** - Critical bugs, security issues, broken functionality
2. **Consider nitpicks carefully** - Some are worth fixing (code clarity), others are stylistic
3. **Verify fixes** - Always rebuild and retest after addressing comments
4. **Commit pattern** - Make separate commits for CodeRabbit fixes to show iteration

### Common CodeRabbit Patterns
- Import consistency (use `fs.readFile` vs destructured `readFile`)
- Edge case handling (check for file named `-` before treating as stdin)
- Resource cleanup (always use finally blocks for temp files)
- Error message clarity (be specific about what's allowed/not allowed)

---

## Architecture Insights

### URL Flow vs Asset Flow
The codebase has two distinct processing paths:
- **URL Flow** (`src/run/flows/url/`) - Handles websites, YouTube, podcasts
- **Asset Flow** (`src/run/flows/asset/`) - Handles local files and stdin

**Key insight:** Markdown converters are created in the URL flow but can be reused in asset flow with proper refactoring. The transcript-to-markdown converter doesn't require URL-specific context.

### Temp File Strategy
For stdin support, the temp-file approach is clean because:
- Reuses existing `handleFileInput` logic
- Minimal code duplication
- Maintains consistency with file processing
- Easy cleanup in finally blocks

```typescript
const tempPath = path.join(
  os.tmpdir(),
  `summarize-stdin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
)
try {
  await fs.writeFile(tempPath, content, { mode: 0o600 })
  // Process as file...
} finally {
  await fs.rm(tempPath, { force: true }).catch(() => {})
}
```

---

## Git Workflow for Upstream Contributions

### Creating PRs to Upstream
**Best practice:** Create upstream PR directly from feature branch without merging to fork main first.

```bash
# Push feature branch
git push origin feature/stdin-temp-file-support

# Create PR to upstream from feature branch
gh pr create --repo steipete/summarize \
  --title "feat: add stdin support" \
  --base main \
  --head mvance:feature/stdin-temp-file-support
```

**Why this works:**
- Keeps PR open for upstream review
- Clean history
- Can push updates to same branch
- After upstream merge, sync your fork's main

### Commit Message Conventions
We used conventional commits throughout:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation updates
- `refactor:` - Code restructuring

---

## Error Handling Best Practices

### Guard Clause Ordering
**Lesson:** Order matters when stacking guard clauses. We had a bug where a later guard contradicted earlier logic:

```typescript
// BAD - Third guard rejects file inputs
if (markdownModeExplicitlySet && inputTarget.kind !== 'url') {
  throw new Error('Only URLs')
}
if (markdownModeExplicitlySet && inputTarget.kind === 'file' && markdownMode !== 'llm') {
  throw new Error('Only llm mode for files')
}
if (markdownModeExplicitlySet && inputTarget.kind !== 'url' && inputTarget.kind !== 'stdin') {
  throw new Error('Only URLs')  // BUG: rejects files!
}

// GOOD - Removed redundant third guard
if (markdownModeExplicitlySet && 
    inputTarget.kind !== 'url' && 
    inputTarget.kind !== 'file' && 
    inputTarget.kind !== 'stdin') {
  throw new Error('Only URL, file, or stdin')
}
if (markdownModeExplicitlySet && 
    (inputTarget.kind === 'file' || inputTarget.kind === 'stdin') && 
    markdownMode !== 'llm') {
  throw new Error('Only llm mode')
}
// No third guard needed - covered by first two
```

### Error Message Clarity
Bad: `'--markdown-mode is only supported for URL inputs (--markdown-mode llm coming soon)'`

Good: `'Only --markdown-mode llm is supported for file/stdin inputs; other modes require a URL'`

**Why:** The first message suggests llm mode isn't supported yet, when it actually is. Be precise about what's allowed vs what's not.

---

## Documentation Tips

### README Updates
When adding new features:
1. Add clear examples showing the intended use case
2. Remove examples that are antipatterns (e.g., `cat file | summarize -` when direct file path is better)
3. Keep notes consistent with examples

### Help Text Consistency
- Update both rich help and concise help
- Use consistent formatting
- Avoid awkward syntax like `<url-or-file-or-->` - prefer `<input>` with description

---

## Security Considerations

### Temp File Permissions
Always set restrictive permissions on temp files:
```typescript
await fs.writeFile(tempPath, content, { mode: 0o600 })
```

### Input Size Limits
Prevent OOM with streaming size checks:
```typescript
async function streamToString(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += buffer.length
    if (totalSize > maxBytes) {
      throw new Error(`Content exceeds ${(maxBytes / 1024 / 1024).toFixed(1)}MB`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
```

---

## Testing Checklist

Before marking a feature complete:
- [ ] Build passes (`pnpm build`)
- [ ] Linting passes (`pnpm lint`)
- [ ] Unit tests pass (`pnpm test`)
- [ ] Manual testing of core functionality
- [ ] Edge cases tested (empty input, oversized input, etc.)
- [ ] Error messages verified
- [ ] Help text reviewed
- [ ] Documentation updated

---

## Common Pitfalls

1. **Assuming file checks happen in order** - Always check if path exists before treating `-` as stdin
2. **Forgetting to update all related checks** - When changing input types, update all guards that check `inputTarget.kind`
3. **Redundant validation** - Don't duplicate guard logic; each condition should have a single purpose
4. **Unclear error messages** - Users should immediately understand what's wrong and how to fix it

---

## Useful Commands

```bash
# Run specific test files
pnpm test tests/cli.stdin.test.ts --run

# Run multiple test files
pnpm test tests/cli.stdin.test.ts tests/input.resolve-input-target.test.ts --run

# Build and check
pnpm build && pnpm lint

# Check git status
git status && git log --oneline -3

# View PR comments
gh pr view 3 --repo mvance/summarize --comments
```

---

## References

- **Upstream PR:** https://github.com/steipete/summarize/pull/68
- **Fork PR:** https://github.com/mvance/summarize/pull/3
- **Feature Branch:** `feature/stdin-temp-file-support`
- **Main Files Changed:**
  - `src/content/asset.ts` - InputTarget type and resolution
  - `src/run/runner.ts` - Stdin handling logic
  - `src/run/help.ts` - Help text updates
  - `tests/cli.stdin.test.ts` - New test suite
  - `tests/input.resolve-input-target.test.ts` - Stdin resolution tests
  - `README.md` - Documentation
