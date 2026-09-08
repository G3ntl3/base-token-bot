import { getAddress } from "viem";
import { selectRoute } from "../../src/trading/route";
import type { CandidateQuote } from "../../src/trading/quote";
import type { DexAdapter } from "../../src/dex/DexAdapter";

const TOKEN = getAddress("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
const WETH = getAddress("0x4200000000000000000000000000000000000006");

const DEAD = getAddress("0x000000000000000000000000000000000000dEaD");

function mockAdapter(name: string): DexAdapter {
  return {
    name,
    routerAddress: DEAD,
    discoverPools: jest.fn(),
    getQuote: jest.fn(),
    buildSwapTransaction: jest.fn(),
  };
}

function poolAddressFor(dex: string): `0x${string}` {
  const digit = (dex.length % 9).toString();
  // 39 zeros + 1 digit = 40 hex chars total; use getAddress to produce the
  // correctly checksummed form rather than hand-casing it.
  return getAddress("0x" + "0".repeat(39) + digit);
}

function candidate(opts: {
  dex: string;
  liquidityEth: bigint;
  amountOut: bigint;
}): CandidateQuote {
  const poolAddress = poolAddressFor(opts.dex);
  return {
    discovered: {
      adapter: mockAdapter(opts.dex),
      pool: {
        dex: opts.dex,
        address: poolAddress,
        token0: WETH,
        token1: TOKEN,
        concentrated: false,
        estimatedLiquidityEthWei: opts.liquidityEth,
      },
    },
    quote: {
      dex: opts.dex,
      pool: {
        dex: opts.dex,
        address: poolAddress,
        token0: WETH,
        token1: TOKEN,
        concentrated: false,
      },
      tokenIn: WETH,
      tokenOut: TOKEN,
      amountInWei: 100_000_000_000_000n,
      amountOutWei: opts.amountOut,
      expiresAt: Date.now() + 20_000,
      routerAddress: DEAD,
    },
  };
}

describe("route selection (mock DEX adapters)", () => {
  it("prefers deeper liquidity over a slightly better price from a thin pool", () => {
    const thinButBetterPrice = candidate({
      dex: "thin-dex",
      liquidityEth: 300_000_000_000_000_000n, // 0.3 ETH, just above the 0.25 minimum
      amountOut: 2_000_000_000_000_000_000n, // higher output
    });
    const deepPool = candidate({
      dex: "deep-dex",
      liquidityEth: 50_000_000_000_000_000_000n, // 50 ETH
      amountOut: 1_900_000_000_000_000_000n, // slightly lower output
    });

    const { selected } = selectRoute([thinButBetterPrice, deepPool], 1_000_000_000n);
    expect(selected?.discovered.adapter.name).toBe("deep-dex");
  });

  it("rejects routes below the minimum liquidity threshold entirely", () => {
    const belowMin = candidate({
      dex: "too-thin",
      liquidityEth: 10_000_000_000_000_000n, // 0.01 ETH, below the 0.25 minimum
      amountOut: 5_000_000_000_000_000_000n,
    });
    const { selected, scored } = selectRoute([belowMin], 1_000_000_000n);
    expect(selected).toBeNull();
    expect(scored[0].reasonsRejected.length).toBeGreaterThan(0);
  });

  it("returns null when no candidates are given", () => {
    const { selected } = selectRoute([], 1_000_000_000n);
    expect(selected).toBeNull();
  });
});
