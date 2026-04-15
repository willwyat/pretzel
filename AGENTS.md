# Agent instructions (Pretzel repo)

When you create a **commit** in this repository, follow this checklist unless the user explicitly opts out.

## Version bump ([VERSION](VERSION))

1. **Choose semver bump**
   - **Patch** (default): fixes, docs-only, internal refactors with no API/behavior change for operators.
   - **Minor**: new behavior, new endpoints, or user-visible features that stay backward compatible.
   - **Major**: breaking changes to HTTP APIs, ports, env vars, or systemd expectations.

2. **Edit `VERSION`** at the repo root so it matches the new semver (single line, no `v` prefix).

3. **Keep examples honest:** If you change `VERSION`, update the **commented** `Environment=PRETZEL_STACK_VERSION=…` lines in:
   - [remote-ui/remote-ui.service.example](remote-ui/remote-ui.service.example)
   - [tv-relay/tv-relay.service.example](tv-relay/tv-relay.service.example)
   - [pretzel-server/pretzel-server.service.example](pretzel-server/pretzel-server.service.example)

4. **README:** Update [README.md](README.md) if ports, paths, component table, or deploy steps changed.

## Git tags (releases only)

- **Do not** create a git tag on every commit unless the user explicitly asks for that workflow.
- When the user asks for a **release** or **tag**: after committing, create an **annotated** tag matching `VERSION`:
  - `git tag -a v$(cat VERSION | tr -d '\r\n') -m "Release $(cat VERSION | tr -d '\r\n')"`
  - Remind them to run `git push origin main` and `git push origin vX.Y.Z` (or push all tags with care).

Tags can be turned into **GitHub Releases** in the GitHub UI for release notes.

## Do not

- Modify repositories outside this project (e.g. wyat-ai) unless the user clearly requests it.
