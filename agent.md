# Instruction

On every commit, always update the application's version number.

- Update `version` in `package.json`.
- Ensure the UI displays the version via `/api/config` (`version` field).
- Version format is **X.Y.Z**:
  - **X** is set only by the user.
  - **Y** is incremented when starting work on a new branch.
  - **Z** is incremented for every commit on a branch.

On every code change, always update the documentation.

- Update `README.md` to reflect any behavior/usage changes introduced by the code modification.
