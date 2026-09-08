# Base Token-Launch Monitoring & Trading Bot

A Telegram bot that watches a specific ERC-20 token on Base, discovers where it
becomes tradable across supported DEX venues, gets a quote, runs it through a
strict safety engine, and prepares (and, only when you explicitly say so,
submits) a swap. Dry-run is the default and the safety engine is the real
gatekeeper — not a UI toggle.

## 1. Project structure

```
src/
  bot/
    commands are inline in telegram.ts; middleware/auth.ts gates admin-only commands
    telegram.ts
  blockchain/
    base.ts                  # RPC clients (HTTP w/ failover, WS)
    contracts/abis.ts        # ERC20 + router/factory/quoter ABIs
    monitoring/blockWatcher.ts
  dex/
    DexAdapter.ts             # shared interface + types
    discovery/
      discovery.ts            # runs all adapters concurrently
      known-addresses.ts       # documented Base venue addresses
    adapters/
      uniswapV3.ts
      aerodrome.ts
      zeroXAggregator.ts       # optional, requires ZEROX_API_KEY
  trading/
    quote.ts
    route.ts                   # safest-route selection, not highest-output
    safety.ts                  # the pre-flight gate
    transaction-builder.ts
    signer.ts                  # TransactionSigner, DryRunSigner, PrivateKeySigner
  token/inspector.ts
  state/
    state-machine.ts
    repository.ts               # SQLite persistence, duplicate prevention
  config/env.ts                  # Zod-validated environment
  logging/logger.ts
  app.ts                          # orchestrates discovery -> quote -> safety -> build
  index.ts                         # entrypoint
tests/
  token/ dex/ trading/ safety/ bot/
```

## 2. Installation

```bash
npm install
cp .env.example .env
# edit .env: at minimum set TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_IDS
```

`better-sqlite3` compiles a native module on install; if you're on an unusual
platform and it fails, install build tools (`build-essential`/Xcode CLT) or
swap in a pure-JS SQLite driver.

## 3. Local development (dry run, no funds at risk)

```bash
npm run dev
```

With `DRY_RUN=true` and `SIGNER_MODE=dryrun` (the defaults), the bot will:

- validate and inspect the configured token,
- watch new blocks/logs on Base Mainnet,
- discover pools, quote them, run every safety check, and build a real,
  fully-formed unsigned transaction,
- but the `DryRunSigner` refuses to sign or broadcast anything. `/authorize`
  in dry-run mode logs and reports success without touching the network.

Talk to your bot in Telegram: `/start`, `/setca <address>`, `/quote`,
`/dryrun`, `/status`.

## 4. Testing against Base Sepolia

Base Sepolia is a fully separate network — you'll want a token you actually
control there rather than the mainnet CA above.

```bash
CHAIN_ID=84532
BASE_RPC_URL=https://sepolia.base.org
BASE_WS_RPC_URL=wss://base-sepolia-rpc.publicnode.com
TOKEN_CA=<your Sepolia test token address>
```

Notes:
- Uniswap V3 and Aerodrome's Sepolia deployments use **different addresses**
  than mainnet. `src/dex/discovery/known-addresses.ts` only hardcodes the
  mainnet addresses; you'll need to add a Sepolia address set (or source them
  from each protocol's official Sepolia deployment docs) before adapters will
  find anything on testnet. This is intentional — the project does not guess
  addresses for a network it wasn't given documented addresses for.
- Use a testnet faucet for Sepolia ETH. Never point `WALLET_PRIVATE_KEY` at a
  wallet holding real funds while testing.

## 5. Running unit / integration tests

```bash
npm test
```

Covers: env validation, integer slippage math, the state machine's legal
transitions, duplicate-execution / one-shot prevention (including a simulated
process restart against the same SQLite file), the safety engine's individual
checks, mock-adapter route selection (deepest liquidity wins over a
marginally better price from a thinner pool), calldata encode/decode
round-trips (and cross-router mismatch detection), and the Telegram
admin-only middleware.

## 6. Mainnet deployment

1. Run everything in dry-run first against the real mainnet token and confirm
   `/quote` and `/dryrun` output looks correct and the safety engine passes.
2. Deploy behind a process manager (systemd/pm2) or a container, with `.env`
   injected via your platform's secret manager — not committed to git, not
   baked into an image layer.
3. Restrict `TELEGRAM_ADMIN_IDS` to your own Telegram numeric user id(s) only.
4. Fill in `ROUTER_ALLOWLIST` explicitly rather than relying on the adapter
   defaults, especially if you enable the 0x aggregator adapter (its router
   address is returned per-quote and must be reviewed and allowlisted by you;
   see `zeroXAggregator.ts`).
5. Only when you're ready to actually risk funds: set `SIGNER_MODE=privatekey`
   and `WALLET_PRIVATE_KEY=<your key>`, keep `DRY_RUN=true` for one more pass
   so you can see the exact prepared transaction with a real signer address
   attached (still nothing is sent), then flip `DRY_RUN=false`.
6. Fund the wallet named by `/balance` with slightly more than `MAX_BUY_ETH`
   to cover gas.

## 7. Where the manual authorization step connects (important)

This is the part that matters most for safety, so it's explicit end to end:

- `app.runCycle()` (triggered by `/quote`, or by the autobuy poll loop when
  `/autobuy on`) does discovery → quote → route-selection → build → **full
  safety-check pass**, and stops at state `TRANSACTION_READY`. It never signs
  or sends anything, regardless of `DRY_RUN` or `SIGNER_MODE`.
- The **only** function in the whole codebase that can move a trade past
  `TRANSACTION_READY` is `app.authorizeAndSend(executionId)`, and the **only**
  caller of that function is the `/authorize <executionId>` Telegram command,
  which is itself gated by the `adminOnly` middleware (so only your configured
  Telegram user id can invoke it).
- `authorizeAndSend` re-runs every safety check fresh (not reusing the
  earlier pass, since time has elapsed and a quote could have expired) before
  calling `signer.signAndSend(tx)`.
- `signer.signAndSend` on `PrivateKeySigner` itself refuses to broadcast if
  `DRY_RUN=true`, as a second, independent gate below the Telegram layer.
- If you want a *manual, outside-the-bot* authorization step instead (e.g. you
  sign in a separate hardware-wallet-connected tool), the integration point is
  exactly the same: swap `authorizeAndSend`'s call to `signer.signAndSend(tx)`
  for a step that exports `tx` (the fully-built, safety-checked
  `UnsignedTransaction`) to wherever your external signing happens, and have
  that external process report the resulting hash back in to
  `repository.transition(executionId, "SUBMITTED", { txHash })`.

There is no code path anywhere that submits a transaction without going
through `/authorize` (or your external equivalent above) first.

## 8. Security notes specific to the private-key signer

`WALLET_PRIVATE_KEY` is:
- read once at process start from the environment, never from a Telegram
  message, database row, or config file the bot writes,
- never included in any Telegram reply, log line (the logger has explicit
  redaction rules), or database record,
- only ever used to sign after `DRY_RUN=false` **and** an admin's explicit
  `/authorize` command for a specific, already safety-checked trade.

Treat the `.env` file itself as a secret: restrictive file permissions, not
committed to git (`.env` should be in `.gitignore`), and ideally injected via
your platform's secret manager rather than living on disk long-term on a
shared machine.
