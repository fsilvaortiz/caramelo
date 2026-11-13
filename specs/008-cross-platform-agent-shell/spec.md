# Feature Specification: Cross-Platform Agent Shell Tool

**Feature Branch**: `008-cross-platform-agent-shell`  
**Created**: 2026-11-13  
**Status**: Draft  
**Input**: User description: "The agent's bash tool always runs `/bin/sh -c`, which does not exist on Windows. Make the shell tool work on Windows, macOS and Linux with the same safety guarantees (approval prompt, workspace-confined cwd, timeout, output truncation)."

## Context

When the agent loop runs a task (Run Task, Converge), the LLM may call the shell tool to build or test code. On Windows the tool fails because it always spawns `/bin/sh`, so Windows users silently lose the ability to let the agent verify its own work, even though CI already runs smoke tests on Windows. Safety rules from Constitution Principles VII and VIII (approval prompt, workspace root boundary, untrusted-workspace block) must hold on every platform.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Windows user runs a task that needs a shell command (Priority: P1)

A developer on Windows runs a task; the agent asks to run `npm test`. After the developer approves, the command runs in the workspace and the agent receives its exit code and output.

**Why this priority**: The feature is completely broken on one of the three supported platforms.

**Independent Test**: On Windows, run a task that requires the agent to execute a command; approve it; confirm output and exit code are returned to the agent.

**Acceptance Scenarios**:

1. **Given** Windows and an approved command `echo hello`, **When** the tool runs, **Then** the result contains `hello` and exit code 0.
2. **Given** Windows and a failing command, **When** the tool runs, **Then** the agent receives the non-zero exit code and stderr.
3. **Given** Windows and a command that exceeds the timeout, **When** the timeout fires, **Then** the whole process tree is terminated and the result reports a timeout.

---

### User Story 2 - The agent knows which shell it is talking to (Priority: P2)

The tool description given to the LLM states which shell will run the command (POSIX `sh` or the Windows shell), so the model writes commands in the right syntax.

**Why this priority**: Without it the model emits POSIX syntax on Windows and wastes iterations.

**Independent Test**: Inspect the tool definition sent to the provider on each platform; it names the correct shell.

**Acceptance Scenarios**:

1. **Given** Windows, **When** the tool list is sent to the provider, **Then** the shell tool's description names the Windows shell.
2. **Given** macOS/Linux, **When** the tool list is sent, **Then** it names POSIX `sh` (unchanged behavior).

---

### User Story 3 - Users can choose their shell (Priority: P3)

A developer who prefers PowerShell (or a specific POSIX shell) sets it in settings and the agent uses it.

**Why this priority**: Nice to have; the default must work without configuration.

**Independent Test**: Set the shell setting to PowerShell on Windows; run `Get-Location`; confirm it executes.

**Acceptance Scenarios**:

1. **Given** a configured shell path, **When** the tool runs, **Then** that shell is used and named in the approval prompt.
2. **Given** a configured shell path that does not exist, **When** the tool runs, **Then** it returns an actionable error naming the setting.

### Edge Cases

- Commands containing quotes, `&&`, pipes or non-ASCII characters on Windows.
- Process trees (e.g. `npm` spawning `node`) must be fully killed on timeout/abort on every platform.
- Output in non-UTF-8 console code pages on Windows must not crash the tool.
- Workspace paths containing spaces.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The shell tool MUST select a working default shell per platform: POSIX `sh` on macOS/Linux and the Windows command shell on Windows.
- **FR-002**: Users MUST be able to override the shell through a setting; the default MUST require no configuration.
- **FR-003**: The tool description and the approval prompt MUST name the shell that will execute the command.
- **FR-004**: The existing guarantees MUST hold on every platform: per-call user approval showing the literal command, cwd confined to the workspace, default 30 s / max 120 s timeout, stdout/stderr truncated to 10 KB each, abort support, blocked in untrusted workspaces.
- **FR-005**: On timeout or abort the tool MUST terminate the entire process tree on every platform.
- **FR-006**: Failures to start the shell MUST produce an actionable error (which shell, which setting to change).
- **FR-007**: Automated tests MUST cover shell selection logic for each platform, and CI on Windows MUST execute at least one real command through the tool.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The shell tool succeeds on Windows, macOS and Linux in CI for a fixed set of reference commands (echo, failing exit code, timeout).
- **SC-002**: 0 orphaned child processes remain after timeout/abort tests on any platform.
- **SC-003**: Windows users can complete a Run Task flow that requires one shell command with no manual configuration.

## Assumptions

- Windows default is `cmd.exe`; PowerShell is opt-in via setting.
- The existing `caramelo.enableBashTool` setting keeps gating the tool; its name is kept for backward compatibility even though the tool is no longer bash-only.
- WSL is out of scope; users who want it can point the shell setting at it.
