import { applySlippageFloor } from "../../src/dex/adapters/uniswapV3";

describe("applySlippageFloor", () => {
  it("computes exact integer floor for typical slippage", () => {
    // 1,000,000 units, 3% slippage (300 bps) -> 970,000
    expect(applySlippageFloor(1_000_000n, 300)).toBe(970_000n);
  });

  it("handles 0 bps slippage (no reduction)", () => {
    expect(applySlippageFloor(500n, 0)).toBe(500n);
  });

  it("handles large bps close to 100%", () => {
    expect(applySlippageFloor(1000n, 9999)).toBe(0n); // floor(1000*1/10000)=0
  });

  it("never uses floating point (odd numbers stay exact integers)", () => {
    const result = applySlippageFloor(333n, 333); // 3.33%
    expect(Number.isInteger(Number(result))).toBe(true);
    expect(result).toBe((333n * 9667n) / 10000n);
  });
});
