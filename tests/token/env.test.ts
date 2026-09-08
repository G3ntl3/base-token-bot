describe("env config", () => {
  it("parses valid environment and computes MAX_BUY_WEI without floats", () => {
    jest.resetModules();
    const { env } = require("../../src/config/env");
    expect(env.CHAIN_ID).toBe(8453);
    expect(env.MAX_BUY_WEI).toBe(100000000000000n); // 0.0001 ETH in wei
    expect(typeof env.MAX_BUY_WEI).toBe("bigint");
  });

  it("rejects an invalid token address", () => {
    jest.resetModules();
    process.env.TOKEN_CA = "not-an-address";
    expect(() => require("../../src/config/env")).toThrow();
    process.env.TOKEN_CA = "0xB095274743941e953c746F9C228DA9c18Bb6ec29";
  });

  it("rejects CHAIN_ID values other than Base mainnet/sepolia", () => {
    jest.resetModules();
    process.env.CHAIN_ID = "1"; // Ethereum mainnet, not allowed
    expect(() => require("../../src/config/env")).toThrow();
    process.env.CHAIN_ID = "8453";
  });
});
