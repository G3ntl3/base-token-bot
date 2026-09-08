import { encodeFunctionData, decodeFunctionData, getAddress } from "viem";
import { uniswapV3SwapRouterAbi, aerodromeRouterAbi } from "../../src/blockchain/contracts/abis";

const TOKEN = getAddress("0xB095274743941e953c746F9C228DA9c18Bb6ec29");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const RECIPIENT = getAddress("0x00000000000000000000000000000000000000B0");

describe("calldata validation", () => {
  it("round-trips Uniswap V3 exactInputSingle calldata and matches expected params", () => {
    const data = encodeFunctionData({
      abi: uniswapV3SwapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WETH,
          tokenOut: TOKEN,
          fee: 3000,
          recipient: RECIPIENT,
          amountIn: 100_000_000_000_000n,
          amountOutMinimum: 900_000n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const decoded = decodeFunctionData({ abi: uniswapV3SwapRouterAbi, data });
    expect(decoded.functionName).toBe("exactInputSingle");
    const params = decoded.args[0] as any;
    expect(params.tokenOut.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(params.amountIn).toBe(100_000_000_000_000n);
  });

  it("round-trips Aerodrome swapExactETHForTokens calldata", () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const data = encodeFunctionData({
      abi: aerodromeRouterAbi,
      functionName: "swapExactETHForTokens",
      args: [
        900_000n,
        [{ from: WETH, to: TOKEN, stable: false, factory: getAddress("0x420DD381b31aEf6683db6B902084cB0FFECe40Da") }],
        RECIPIENT,
        deadline,
      ],
    });

    const decoded = decodeFunctionData({ abi: aerodromeRouterAbi, data });
    expect(decoded.functionName).toBe("swapExactETHForTokens");
  });

  it("throws when decoding calldata against the wrong ABI (detects mismatched router)", () => {
    const uniswapData = encodeFunctionData({
      abi: uniswapV3SwapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WETH,
          tokenOut: TOKEN,
          fee: 3000,
          recipient: RECIPIENT,
          amountIn: 1n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    expect(() => decodeFunctionData({ abi: aerodromeRouterAbi, data: uniswapData })).toThrow();
  });
});
