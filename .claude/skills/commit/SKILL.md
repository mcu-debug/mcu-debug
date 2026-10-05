---
name: commit
description: Summarize the staged changes and draft a commit message for the user to paste. Never runs git commit.
---

1. Print a high-level, bulleted summary of the staged changes (`git diff --cached`) for review.
   If nothing is staged, say so and stop.
2. Draft the commit message in Conventional Commits style:
   - One logical change: a single line, e.g. `feat(auth): add JWT expiration handling`.
   - Several: a one-line subject, a blank line, then one bullet per change, e.g.
     ```
     feat(auth,rtt): add JWT expiry; fix RTT write off-by-one

     - feat(auth): add JWT expiration handling
     - fix(rtt): off by one error on writes to device
     ```
3. Present the message in a code block for the user to copy into an editor.
   Never run `git commit` yourself.

