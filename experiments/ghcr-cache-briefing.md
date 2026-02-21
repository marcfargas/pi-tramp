# Task: Cache Windows Test Container in GHCR

## Context

The `test-integration-windows` CI job in `.github/workflows/ci.yml` builds a Windows Docker
container from `test/fixtures/windows-ssh-server/Dockerfile` on every run. This downloads
pwsh 7 (~100MB), full Git for Windows (~500MB), installs OpenSSH, creates users and keys.
It takes 5-10+ minutes each time.

## Working Root

**Your working root is C:/dev/pi-tramp-wt-ghcr/** — all edits must go there.

## What to Implement

### 1. Modify `.github/workflows/ci.yml` — `test-integration-windows` job

Replace the current "Build Windows test container" step with a pull-or-build pattern:

```yaml
- name: Compute Dockerfile hash
  id: df-hash
  shell: bash
  run: echo "hash=$(sha256sum test/fixtures/windows-ssh-server/Dockerfile | cut -c1-12)" >> "$GITHUB_OUTPUT"

- name: Login to GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- name: Pull or build Windows test container
  shell: pwsh
  run: |
    $image = "ghcr.io/${{ github.repository_owner }}/pi-tramp-win-test"
    $tag = "${{ steps.df-hash.outputs.hash }}"
    $fullTag = "${image}:${tag}"
    
    # Try to pull cached image
    docker pull $fullTag 2>$null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "✅ Using cached image: $fullTag"
      docker tag $fullTag pi-tramp-win-test
    } else {
      Write-Host "🔨 Cache miss — building from scratch"
      docker build -t pi-tramp-win-test test/fixtures/windows-ssh-server/
      docker tag pi-tramp-win-test $fullTag
      docker push $fullTag
      # Also push as :latest
      docker tag pi-tramp-win-test "${image}:latest"
      docker push "${image}:latest"
    }
```

### 2. Repository permissions

Add `permissions` at the job level to allow GHCR push:

```yaml
test-integration-windows:
  runs-on: windows-latest
  permissions:
    contents: read
    packages: write
  steps:
    ...
```

### 3. Important details

- **Registry**: `ghcr.io/marcfargas/pi-tramp-win-test` (lowercase owner)
- **Tag strategy**: first 12 chars of SHA-256 of the Dockerfile content
- **Fallback**: if pull fails, build locally and push (first run or Dockerfile change)
- **Also tag as `:latest`** for convenience
- The rest of the job (start container, wait for SSH, run tests) stays exactly the same
- `GITHUB_TOKEN` has `packages:write` by default in Actions when `permissions` is set
- The local image name `pi-tramp-win-test` must stay the same (tests reference it)
- Do NOT add a separate workflow — keep it simple, build-and-push inline

### 4. Also add the Linux container caching

The Linux integration job builds a container too. Apply the same pattern:

Check `.github/workflows/ci.yml` for `test-integration-linux`. It builds from
`test/fixtures/ssh-server/Dockerfile`. Apply identical pull-or-build logic with
image `ghcr.io/marcfargas/pi-tramp-ssh-test` (or similar), same hash-based tag.

### 5. Verify

```bash
cd /c/dev/pi-tramp-wt-ghcr
npm run lint
npm run typecheck
```

YAML changes won't affect local tests. Just make sure lint/typecheck pass (no source changes).

### 6. Commit

```bash
git add -A && git commit -m "ci: cache test containers in GHCR (pull-or-build pattern)

Windows and Linux integration test containers are now cached in GHCR.
First run builds and pushes; subsequent runs pull the cached image.
Cache key: first 12 chars of Dockerfile SHA-256 hash.
Rebuilds automatically on Dockerfile changes."
```

## Out of Scope

- Don't modify the Dockerfile itself
- Don't change any source code or tests
- Don't add separate rebuild workflows
