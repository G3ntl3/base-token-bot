import { encodeFunctionData, getAddress } from "viem";
import { uniswapV3SwapRouterAbi } from "../../src/blockchain/contracts/abis";

jest.mock("../../src/blockchain/base", () => ({
  httpClient: {
    getChainId: jest.fn().mockResolvedValue(8453),
  },
}));

import { runSafetyChecks } from "../../src/trading/safety";
import type { Quote, UnsignedTransaction } from "../../src/dex/DexAdapter";
import { ExecutionRepository } from "../../src/state/repository";

const TOKEN = getAddress("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
const ROUTER = getAddress("0x2626664c2603336E57B271c5C0b26F421741e481");
const RECIPIENT = getAddress("0x00000000000000000000000000000000000000B0");

function buildQuoteAndTx(overrides: Partial<Quote> = {}): { quote: Quote; tx: UnsignedTransaction } {
  const quote: Quote = {
    dex: "uniswap-v3",
    pool: {
      dex: "uniswap-v3",
      address: getAddress("0x0000000000000000000000000000000000000001"),
      token0: TOKEN,
      token1: TOKEN,
      concentrated: true,
      feeBps: 30,
    },
    tokenIn: getAddress("0x4200000000000000000000000000000000000006"),
    tokenOut: TOKEN,
    amountInWei: 100_000_000_000_000n, // 0.0001 ETH
    amountOutWei: 1_000_000_000_000_000_000n,
    expiresAt: Date.now() + 20_000,
    routerAddress: ROUTER,
    ...overrides,
  };

  const data = encodeFunctionData({
    abi: uniswapV3SwapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        fee: 3000,
        recipient: RECIPIENT,
        amountIn: quote.amountInWei,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const tx: UnsignedTransaction = {
    chainId: 8453,
    to: ROUTER,
    data,
    value: quote.amountInWei,
    gas: 300_000n,
  };

  return { quote, tx };
}

describe("safety engine", () => {
  let repo: ExecutionRepository;

  beforeEach(() => {
    repo = new ExecutionRepository(":memory:");
  });

  afterEach(() => repo.close());

  it("passes a well-formed, in-limits trade", async () => {
    const { quote, tx } = buildQuoteAndTx();
    const result = await runSafetyChecks({
      quote,
      tx,
      slippageBps: 300,
      maxSpendWei: 100_000_000_000_000n,
      routerAllowlist: [ROUTER],
      configuredTokenCA: TOKEN,
      repository: repo,
    });
    expect(result.ok).toBe(true);
    expect(result.failedChecks).toEqual([]);
  });

  it("fails when spend exceeds the configured maximum", async () => {
    const { quote, tx } = buildQuoteAndTx({ amountInWei: 999_000_000_000_000n });
    tx.value = 999_000_000_000_000n;
    const result = await runSafetyChecks({
      quote,
      tx,
      slippageBps: 300,
      maxSpendWei: 100_000_000_000_000n,
      routerAllowlist: [ROUTER],
      configuredTokenCA: TOKEN,
      repository: repo,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("within_max_spend");
  });

  it("fails when router is not on the allowlist", async () => {
    const { quote, tx } = buildQuoteAndTx();
    const result = await runSafetyChecks({
      quote,
      tx,
      slippageBps: 300,
      maxSpendWei: 100_000_000_000_000n,
      routerAllowlist: [getAddress("0x00000000000000000000000000000000000000fF")],
      configuredTokenCA: TOKEN,
      repository: repo,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("router_on_allowlist");
  });

  it("fails when the token does not match the configured CA", async () => {
    const otherToken = getAddress("0x000000000000000000000000000000000000dEaD");
    const { quote, tx } = buildQuoteAndTx({ tokenOut: otherToken });
    const result = await runSafetyChecks({
      quote,
      tx,
      slippageBps: 300,
      maxSpendWei: 100_000_000_000_000n,
      routerAllowlist: [ROUTER],
      configuredTokenCA: TOKEN,
      repository: repo,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("token_matches_configured_ca");
  });

  it("fails when the quote has expired", async () => {
    const { quote, tx } = buildQuoteAndTx({ expiresAt: Date.now() - 1000 });
    const result = await runSafetyChecks({
      quote,
      tx,
      slippageBps: 300,
      maxSpendWei: 100_000_000_000_000n,
      routerAllowlist: [ROUTER],
      configuredTokenCA: TOKEN,
      repository: repo,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("quote_not_expired");
  });

  it("fails when slippage exceeds the configured limit", async () => {
    const { quote, tx } = buildQuoteAndTx();
    const result = await runSafetyChecks({
      quote,
      tx,
      slippageBps: 5000, // way above the 300 bps cap enforced by env in test setup
      maxSpendWei: 100_000_000_000_000n,
      routerAllowlist: [ROUTER],
      configuredTokenCA: TOKEN,
      repository: repo,
    });
    expect(result.ok).toBe(false);
    expect(result.failedChecks).toContain("slippage_within_limit");
  });
});
