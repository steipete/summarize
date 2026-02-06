# Testing Lessons Learned

## Quick Reference for Test Commands

### During Development (Fast Iteration)
```bash
# Run specific test file you're working on
pnpm test tests/your-specific-file.test.ts --run

# Run core unit tests only (fastest feedback)
pnpm test tests/config.test.ts tests/slides-text.utils.test.ts tests/model-auto.test.ts --run

# Run tests with single thread to avoid timeouts
VITEST_MAX_THREADS=1 pnpm test tests/your-file.test.ts --run
```

### Before Committing (Comprehensive Testing)
```bash
# Run linting + type checking (fast, no network)
pnpm lint
pnpm typecheck

# Run core functionality tests (minimal network)
VITEST_MAX_THREADS=1 pnpm test --run --exclude="**/live/**" --exclude="**/*live*.test.ts"

# Full test suite (may take 5-10 minutes, includes network mocks)
VITEST_MAX_THREADS=1 pnpm test --run

# Full check with coverage (slowest, run before major PRs)
VITEST_MAX_THREADS=1 pnpm check
```

## Key Testing Insights

### Timeout Issues
- **Default timeout**: 15 seconds per test (configured in `vitest.config.ts`)
- **Problem**: Import/transform overhead (10-15s) + test execution = timeouts
- **Solution**: Use `VITEST_MAX_THREADS=1` to reduce resource contention

### Test Categories
1. **Fast Unit Tests** (< 1s): Config parsing, utils, model resolution
2. **Medium Integration Tests** (1-5s): Network mocks, file processing
3. **Slow Network Tests** (> 5s): API integration, external service mocks
4. **Live Tests**: Real network calls (requires `SUMMARIZE_LIVE_TESTS=1`)

### Test File Patterns to Watch
- **`tests/live/`** - 18 files with real API calls (usually skipped)
- **`*live.test.ts`** - Network integration tests (skipped by default)
- **`whisper*.test.ts`** - Audio processing tests (slower)
- **`transcript*.test.ts`** - Network-heavy podcast/YouTube tests

### Common Pitfalls

1. **Running Full Suite During Development**
   - ❌ `pnpm test` (280+ files, 5-10 minutes)
   - ✅ `pnpm test tests/your-file.test.ts --run`

2. **Parallel Test Overhead**
   - ❌ Default parallel execution causes timeouts
   - ✅ `VITEST_MAX_THREADS=1 pnpm test --run`

3. **Network Test Timeouts**
   - ❌ Tests make real network calls and timeout
   - ✅ Mock network calls or exclude live tests

4. **Missing Environment Variables**
   - Some tests require API keys even when mocked
   - Check test files for `process.env` usage

### Performance Tips

1. **Reduce Transform Time**
   ```bash
   # Single thread reduces compilation overhead
   VITEST_MAX_THREADS=1 pnpm test --run
   ```

2. **Skip Live Tests During Development**
   ```bash
   # Exclude files that make real network calls
   pnpm test --run --exclude="**/live/**" --exclude="**/*live*.test.ts"
   ```

3. **Increase Timeout When Necessary**
   ```bash
   VITEST_TEST_TIMEOUT=30000 pnpm test tests/slow-file.test.ts --run
   ```

### Test Strategy by Change Type

#### Configuration Changes
```bash
pnpm test tests/config.test.ts --run
pnpm lint
```

#### Core Logic Changes
```bash
pnpm test tests/core-logic-file.test.ts --run
VITEST_MAX_THREADS=1 pnpm test tests/unit/ --run
pnpm typecheck
```

#### Network/External API Changes
```bash
VITEST_MAX_THREADS=1 pnpm test tests/network-related.test.ts --run
# Consider running with longer timeout
VITEST_TEST_TIMEOUT=30000 pnpm test tests/network-file.test.ts --run
```

#### CLI/Interface Changes
```bash
VITEST_MAX_THREADS=1 pnpm test tests/cli*.test.ts --run
pnpm typecheck
```

### Before Submitting PR
```bash
# 1. Build and basic checks
pnpm build
pnpm lint
pnpm typecheck

# 2. Core functionality (2-3 minutes)
VITEST_MAX_THREADS=1 pnpm test --run --exclude="**/live/**"

# 3. Full suite if needed (5-10 minutes)
VITEST_MAX_THREADS=1 pnpm test --run

# 4. Final check with coverage (slowest, optional)
VITEST_MAX_THREADS=1 pnpm check
```

### Environment Variables to Know
- `SUMMARIZE_LIVE_TESTS=1` - Enable live network tests
- `VITEST_MAX_THREADS` - Control test parallelism (default: auto, recommend: 1)
- `VITEST_TEST_TIMEOUT` - Override test timeout (default: 15s)
- `CI` - Enables additional coverage reporters

### Troubleshooting

**Tests timing out:**
```bash
VITEST_MAX_THREADS=1 VITEST_TEST_TIMEOUT=30000 pnpm test tests/your-file.test.ts --run
```

**Import/transform taking too long:**
```bash
# Reduce parallelism, run specific files only
VITEST_MAX_THREADS=1 pnpm test tests/small-subset/ --run
```

**Network tests failing:**
```bash
# Check if environment variables are set
env | grep -E "(API_KEY|SUMMARIZE)"
# Exclude live tests if not needed
pnpm test --run --exclude="**/live/**"
```

### Remember
- **Build passes** ✅ - Project is functional
- **Lint/typecheck pass** ✅ - Code quality is good
- **Core tests pass** ✅ - Ready for PR
- **Full tests pass** ✅ - Production ready
- **Live tests pass** 🌟 - Bonus points (requires API keys)