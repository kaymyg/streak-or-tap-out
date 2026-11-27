# Help wanted

Streak or Tap Out is open to contributions. Below is the hardening work that would make it stronger, roughly in order of impact. Pick anything, comment on (or open) an issue so others know you are on it, and see [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

Found a vulnerability instead? Please report it privately, see [SECURITY.md](SECURITY.md).


### Contract audit

**High impact.** Review `StreakToken` and `DailyTap`, especially the verifier signature checks and the mint cap.

### Verifier server review

**High impact.** Test SIWE nonce replay, rate limiting under load and Redis authentication and TLS settings.

### Upgrade Hardhat toolbox

**Medium.** The remaining audit warnings are in development tools only. Moving to `@nomicfoundation/hardhat-toolbox` v7 clears them but is a breaking upgrade that needs testing.
