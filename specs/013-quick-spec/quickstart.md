# Quickstart: Quick Spec Mode

## Try it

1. Open a workspace that has a constitution and an active provider; Claude or another tool-calling provider gives grounded plans.
2. In the Caramelo sidebar, expand **＋ New Spec** and pick **Quick**.
3. Name: `fix-email-case`. Description: *Login fails when the email has uppercase letters.*
4. Click **Create**. The status bar shows *Generating quick spec…*; tool calls (`grep`, `file_read`) stream to the **Caramelo** output channel.
5. `spec.md`, `plan.md` and `tasks.md` appear under `specs/fix-email-case/`. The card shows a **quick** badge and one **Approve** button.
6. Review the three short documents and click **Approve**, then **Implement**. Tasks run like any spec, ending with one summary.
7. Optional: **Promote to full spec** to continue with the three-phase flow.

## Verify (developers)

```bash
npx vitest run src/specs/__tests__/quick-spec.test.ts src/commands/__tests__/quick-spec-commands.test.ts
```

```bash
xvfb-run -a npx vscode-test --grep "Quick spec"
```

Expected:
- The unit tests cover parser, prompt and state rules.
- The e2e test goes create → generate → approve → Run All → converge with no prompts beyond the first-time write and shell questions.
- A `TOO_LARGE` answer writes nothing and shows the "Create full spec instead" notice.
- Turning `caramelo.quickSpec.enabled` off hides **Quick** in the form.
