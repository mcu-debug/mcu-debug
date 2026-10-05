---
name: commit
description: Review staged changes and create a commit message.
---

1. Print a high-level, bulleted summary of the staged changes (`git diff --cached`) for review.
2. Draft a set of single-line commit messages in Conventional Commits style, If it is just one line, omit the bullet. e.g. for multiple edits
    ```
    - feat(auth): add JWT expiration handling
    - fix(rtt): off by one error on writes to device
    ```
3. Present the drafted **commit message** to the user to copy and paste into an editor.
