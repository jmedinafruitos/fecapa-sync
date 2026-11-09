## What and why

<!-- What changes, and why. For a "FECAPA changed" fix: which source, which field, and the error code it raised. No names. -->

## Checklist

- [ ] Tests added or updated; `npm run lint && npm run typecheck && npm test && npm run build` passes
- [ ] A changeset is added (`npx changeset`), or this PR doesn't change behaviour (docs, tests, CI only)
- [ ] No real personal data: fixtures come from `fecapa-sync capture` (invented names, person ids ≥ 900000), and the description, tests and logs hold no names
- [ ] No token, and nothing club-specific (no real club, team or competition names or ids except as public examples)
- [ ] No new requests to FECAPA/SIDGAD, or their reason and budget are explained above
- [ ] `package-lock.json` only references `https://registry.npmjs.org/`
