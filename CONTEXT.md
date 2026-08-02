# Ködade Product Language

Canonical terms for describing Ködade's product and public delivery state.

## Release state

**Public release**:
A signed, notarized, user-tested build published as a stable GitHub Release and linked from kodade.com.
_Avoid_: Build, shipped code, QA artifact

**Supported feature**:
A user-visible capability included in the public release, covered by documentation and an owner-completed acceptance test.
_Avoid_: Implemented feature, merged feature

**Development feature**:
A capability whose source may be public but is not enabled or promised in the
public release. Contributor engineering records may remain when clearly marked
as development-only or historical; launch and support docs must not present the
capability as available.
_Avoid_: Pro feature, hidden feature
