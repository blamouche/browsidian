# Instruction

## Versioning (mandatory)

On every commit, always update the application's version number.

- Update `version` in `package.json`.
- Ensure the UI displays the version via `/api/config` (`version` field).
- Version format is **X.Y.Z**:
  - **X** is set only by the user.
  - **Y** is incremented when starting work on a new branch.
  - **Z** is incremented for every commit on a branch.

## Documentation (mandatory)

On every code change, always update the documentation.

- Update `README.md` to reflect any behavior/usage changes introduced by the code modification.

## UI consistency rules (mandatory)

Any UI change must respect the existing design system and stay consistent with the current interface:

- Keep colors aligned with the existing theme tokens (do not introduce random new colors).
- Keep components coherent, homogeneous, and consistent with existing spacing, radii, shadows, and states (hover/focus/active/disabled).
- Prefer reusing existing CSS variables and component classes instead of adding one-off styles.
