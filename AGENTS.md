# Delivery and CI ownership

- When authorized to push, follow the pushed commit through all required CI
  jobs and artifact publication. A successful push is not completed delivery.
- Inspect failed-job logs, fix in-scope failures, verify locally, commit and
  push the correction, and monitor the replacement run through completion.
- Do not disable tests, security checks, or publication dependencies to make
  a failing pipeline appear successful.
- Verify the published image is associated with the intended commit before
  reporting it available. Distinguish image publication from deployment.
- If completion needs new authority or an external change, report the exact
  blocker instead of silently abandoning a failed or unfinished pipeline.
- Verification must work from a clean checkout. Unit tests must not depend
  on ignored build outputs left by an earlier local run.
