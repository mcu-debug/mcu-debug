#!/bin/bash

# Navigate to repo root
cd "$(git rev-parse --show-toplevel)" || exit 1

echo "Installing git hooks..."

# Ensure the target directory exists
mkdir -p .git/hooks

# Copy/Symlink the hooks
# Using copy to avoid permissions issues across different filesystems/OSs sometimes, but symlink is also fine.
# Let's use copy for robustness as user requested "install".

cp scripts/git-hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

echo "Git hooks installed successfully."
