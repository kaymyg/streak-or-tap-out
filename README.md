# Streak or Tap Out — Base MVP

One chain. Two modes. No bridge, no Solana, no token stakes.

`StreakToken` + `DailyTap` + a verifier server + one page. That is the whole
thing, and it runs end to end on a local chain with no faucet and no domain.

- **Daily** — tap for five seconds, the verifier signs your score, you submit
  it on chain and mint $STREAK. Miss a day and the streak resets.
- **Duel** — head to head for season points. No ante, no pot, nothing on
  chain.

---

## Run it

Four terminals.

```bash
npm install

npm run node            # 1. local chain on :8545
npm run deploy:local    # 2. deploy + write .env and web/deployed.json
npm run server          # 3. verifier on :8787
npm run web             # 4. UI on http://localhost:5173
```

Then open http://localhost:5173, point your wallet at `Localhost 8545`
(chainId 31337), import a Hardhat test account, and play.

Four commands prove it without a browser:

```bash
npm test          # 26 contract tests
npm run test:store # 58 store tests, run against BOTH implementations
npm run e2e       # daily loop: SIWE -> round -> signature -> tap()
npm run e2e:duel  # two players through a full duel
```

The store suite runs the Redis cases only if you give it one, and says so
rather than skipping silently:

```bash
REDIS_TEST_URL=redis://127.0.0.1:6379 npm run test:store
```

Use `scripts/dev-server.sh start|stop|restart [REDIS_URL]` to manage the
verifier. It tracks a PID file instead of `pkill -f`, which kept matching the
shell that invoked it and leaving orphaned servers holding the port — so later
runs talked to the wrong process and passed against stale state.

---

## What's here

```
contracts/StreakToken.sol   fixed-cap ERC-20, MINTER_ROLE held only by DailyTap
contracts/DailyTap.sol      the game contract
test/DailyTap.test.ts       26 tests pinning every claim the design rests on

server/config.ts            tunables, each with the reasoning attached
server/chain.ts             the only module that touches the chain
server/auth.ts              SIWE once, then a 24h bearer token
server/rounds.ts            the ONE place a score is judged plausible
server/duels.ts             points-only duels
server/leaderboard.ts       season standings — points, never tokens
server/index.ts             routes

web/index.html              single-page UI, no bundler
scripts/deploy.ts           token -> tap -> grant, in that order
scripts/lib/client.ts       headless player for the e2e scripts
scripts/e2e.ts              daily loop + its negative cases
scripts/e2e-duel.ts         duel flow + its negative cases
```

---

## The one thing to understand

**The contract cannot verify that anyone tapped. It can only verify that the
server said so.**

Every anti-cheat guarantee lives in `server/index.ts`, in the checks that run
before `signTypedData`. The signature is the server's assertion, not proof of
play. A server that signs a client-supplied score is a rubber stamp.

What the contract adds on top is narrow, and worth being exact about:

| Guard | Stops |
|---|---|
| signature binds `player` | someone else submitting your signature |
| signature binds `day` + `day == currentDay()` | replay after midnight UTC |
| `lastDay[player] < day` | replay within the same day |

Those last two together are a complete replay guard, which is why there is no
nonce — it would cost a storage write and an RPC round-trip and stop nothing.

And the honest limit: a scripted client that opens a session, waits the real
five seconds, and reports a humanly-possible tap count **still gets signed**.
You cannot verify a client-side score. Ever. The plausibility checks raise the
cost of cheating above the value of a day's reward — which is the actual
argument for keeping `BASE_REWARD` small, not a footnote to it.

---

## Numbers, and why they are those numbers

The previous drafts had caps that could never bind. These reconcile:

| | value | why |
|---|---|---|
| scoring window | 5s | the round |
| human ceiling | 13 taps/sec | server signs at most **65** |
| `REF_AVG` | 35 | ~7/sec is a decent run, so typical play sits near 1.0x |
| `MAX_TAPS` (contract) | 100 | above any plausible score; caps a leaked key's damage |
| streak multiplier | 1.1x – 4.0x | caps at day 30 |
| `MAX_PERF` | 2.0x | guards a *depressed* rolling average, not normal play |

Real spread: **~11 $STREAK** on a first tap, **~74** on day 30 with a strong
run, **80** absolute ceiling. Against the 1B cap at 10K DAU that is roughly a
decade of runway — worth re-deriving yourself if you change `BASE_REWARD`,
rather than trusting any number in a document.

`MAX_PERF` never binds while `REF_AVG` is static. It starts mattering the day
you replace it with a trailing 7-day average and that average collapses.

---

## Duels

Asynchronous and points-only. One player creates a duel and gets a six-letter
code; they play whenever, share the code, and the opponent plays whenever they
open the app. No sockets, no presence model, no realtime matchmaking — the
whole feature is a `Map`.

| | |
|---|---|
| win | 3 points |
| draw | 2 each |
| loss | 1 — showing up still counts |
| walkover | 2, if the opponent never shows within 24h |

Three properties worth keeping:

- **Nothing of value moves.** No ante, no pot, no settlement, no chain call.
  The winner's prize is a number in `leaderboard.ts`. This is what keeps duels
  outside wagering, and it is the property a refactor is most likely to break
  — `e2e-duel.ts` asserts it.
- **Scores stay hidden until you have played.** Otherwise the second player
  decides how hard to try after seeing the target.
- **You cannot duel yourself.** With points as the only prize, that is the
  entire exploit surface.

`DuelSettlement.sol` is deliberately absent. Consideration + prize + chance is
the test, and entry fees are consideration whether the pot is split or fixed.
Staked duels can come back after a written legal position, geo-gated.

---

## Decisions baked in

**SIWE once, then a bearer token.** The daily tap needed one authenticated
call, so signing per action was fine. Duels need several, and a wallet popup
each time would be miserable. The token proves address control; it cannot
authorize a transaction, and the verifier signature it unlocks is still bound
to `msg.sender` on chain. A leaked token costs someone their daily round and
some duels — it is not custodial.

**One plausibility check, shared.** `rounds.ts` is the only place that decides
whether a reported score is humanly possible, so daily and duel modes cannot
drift apart.

**The one-per-day gate is the chain's, not the server's.** `/start-session`
reads `lastDay(player)` from the contract. A server-side flag set at session
open would burn the player's day whenever they rejected the wallet popup, ran
out of gas, or closed the tab — and on day 29 of a streak that is the one
failure this game cannot have. `MAX_ATTEMPTS_PER_DAY = 3` keeps an abandoned
session recoverable without turning it into best-of-fifty.

**No maximum round duration.** The scoring window is clamped below
(`min(elapsed, 5s)`), so a long elapsed buys an attacker nothing, while
rejecting it would punish everyone who reads the screen or whose mobile
browser suspends the tab.

**`currentDay()` is re-read before signing.** A session opened at 23:59:57
would otherwise get a signature for yesterday that reverts on submission.

**Web on :5173, verifier on :8787.** Different origins on purpose, so the CORS
allowlist and SIWE domain binding are exercised in dev instead of discovered
in production.

---

## Known limits

- **Sybil is unsolved.** Both gates are per-wallet, so a thousand fresh wallets
  play a thousand real sessions. The mitigations are economic, not
  cryptographic: small rewards, and a prior-transaction gate before any
  leaderboard eligibility. This MVP has no leaderboard precisely so the problem
  does not exist yet.
- **Server state is in memory.** Tokens, rounds, duels, the leaderboard and the
  attempt counters all reset on restart and do not survive a second instance.
  The leaderboard is the one that will hurt — it is the only record a season
  has. Move it to a real store before anyone's standing matters to them.
- **`setVerifier` is plain `onlyOwner`.** Fine for testnet. For mainnet put it
  behind a timelock: an owner who can rotate instantly can also rotate
  maliciously.
- **The hand-rolled SIWE string** in `web/index.html` must match EIP-4361
  exactly, blank lines included. `scripts/e2e.ts` builds it the same way on
  purpose, so drift fails there rather than in someone's wallet.
- **`hardhat.config.ts` pins solc to the npm build** because this sandbox could
  not reach `binaries.soliditylang.org`. On a normal machine, delete the
  `TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD` subtask override.

---

## Storage

Everything the server remembers goes through `server/store/` — one interface,
two implementations, one test suite run against both.

```bash
# unset REDIS_URL  -> in-process Maps. Fine locally.
# REDIS_URL=...    -> Redis. Required for anything deployed.
```

The first version kept all of this in module-level Maps. That is correct in
exactly one situation — a single long-lived process — and silently wrong
everywhere else. Two instances and a round opened on one is invisible to the
other, so `/round/end` fails intermittently. That reads as flakiness rather
than an architecture mismatch, which is the worst kind of bug to inherit.

The leaderboard is why this matters most. Tokens, rounds and duels are all
short-lived; losing them costs someone a round. Standings are the only record
a season has. `GET /health` reports which store is live — check it after any
deploy, because an unset `REDIS_URL` fails silently into the in-memory path.

Two things the shared suite caught that review had not:

- The Redis store wrote losses to a field called `losss` (`${outcome}s`), so
  every loss vanished from the standings.
- The memory store's `mutateDuel` lost concurrent writes. Read, clone, `await`,
  write *looks* atomic in single-threaded JavaScript, but the await is a yield
  point — ten concurrent callers all read the same value and nine updates
  disappear. Redis passed because it takes a lock.

Neither is the kind of bug you find by reading.

---

## Playing it on the live domain today

The fastest way to see the real domain running the real game, before any
hosting exists. The page is static on Vercel; the verifier and chain stay on
your laptop. Only you can play it, which is fine — nobody else knows about it
yet.

It works because browsers treat `http://localhost` as a secure context, so an
HTTPS page is allowed to call it. Everything else would be blocked as mixed
content.

```bash
# 1. publish the page (from the repo root, once)
cd web && npx vercel --prod && cd ..
#    link it to streakortapout.fun in the Vercel dashboard, under Domains

# 2. chain + contracts
npm run node            # terminal 1
npm run deploy:local    # terminal 2

# 3. the verifier, told to expect the live origin
SIWE_DOMAIN=streakortapout.fun \
ALLOWED_ORIGINS=https://streakortapout.fun \
npm start               # terminal 3
```

`web/deployed.json` already carries `apiBase: http://localhost:8787`, so the
deployed page calls your machine. Point your wallet at `Localhost 8545`
(chainId 31337), open https://streakortapout.fun, and play.

Two things this will teach you that localhost cannot: whether your wallet
renders the hand-rolled SIWE message properly against a real domain, and
whether the CORS allowlist is right. Both are things that only fail in
production.

There is deliberately no `?api=` URL override. It would be convenient, and it
would also let anyone send a link that points the page at a verifier they
control and harvest a signed SIWE message from your domain.

---

## Deploying properly

Two hosts, because they have different shapes.

**The page** is static — Vercel, at `streakortapout.fun`. Set `API_BASE` before
running the deploy script so `web/deployed.json` points the page at the
verifier's real host; otherwise the deployed site calls the visitor's own
machine on localhost.

**The verifier** is a long-lived stateful process and does **not** belong on
Vercel functions as written. They are stateless and scale to several
instances. Put it on something that keeps a process alive — Railway, Render,
Fly — with a managed Redis, and give it its own hostname.

```bash
# contracts
export RPC_URL=https://sepolia.base.org
export DEPLOYER_PK=0x...      # funded with Sepolia ETH
export VERIFIER_PK=0x...      # separate key, no funds, signing only
npm run deploy:sepolia

# the page, pointed at the verifier
API_BASE=https://api.streakortapout.fun npm run deploy:sepolia
```

Then on the verifier host:

```
SIWE_DOMAIN=streakortapout.fun
ALLOWED_ORIGINS=https://streakortapout.fun
REDIS_URL=rediss://...
```

`SIWE_DOMAIN` has to match the host the page is served from, exactly. It is
what the wallet shows at sign-in, and a mismatch produces a 401 that looks
like a signature bug. Pin it with the env var rather than reading
`req.hostname`, which drifts behind a proxy.

See `.env.example` for the full set.

---

## Next

In rough order of what the project actually needs:

1. **Play it in a browser.** The e2e scripts prove the server contract, but the
   SIWE string in `web/index.html` is hand-rolled to avoid a bundler, and a
   real wallet rendering it is the only test that counts.
2. **Persist the leaderboard.** Everything else in memory is recoverable; a
   wiped season is not.
3. **Seasons with an end date,** so standings reset and the board means
   something.
4. **Sinks** — cosmetics, season entry. These are the durable revenue line and
   the only thing that gives $STREAK a reason to be spent rather than sold.
5. **Solana, or never.** Not until Base has players.
