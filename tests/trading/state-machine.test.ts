import { isValidTransition } from "../../src/state/state-machine";

describe("execution state machine", () => {
  it("allows the canonical happy path", () => {
    const path: Array<[string, string]> = [
      ["WATCHING", "LIQUIDITY_FOUND"],
      ["LIQUIDITY_FOUND", "QUOTE_READY"],
      ["QUOTE_READY", "TRANSACTION_READY"],
      ["TRANSACTION_READY", "AUTHORIZED"],
      ["AUTHORIZED", "SUBMITTED"],
      ["SUBMITTED", "CONFIRMED"],
    ];
    for (const [from, to] of path) {
      expect(isValidTransition(from as any, to as any)).toBe(true);
    }
  });

  it("rejects skipping states (e.g. WATCHING -> AUTHORIZED)", () => {
    expect(isValidTransition("WATCHING" as any, "AUTHORIZED" as any)).toBe(false);
  });

  it("rejects any transition out of CONFIRMED (terminal state)", () => {
    expect(isValidTransition("CONFIRMED" as any, "WATCHING" as any)).toBe(false);
  });

  it("allows recovering from FAILED back to WATCHING", () => {
    expect(isValidTransition("FAILED" as any, "WATCHING" as any)).toBe(true);
  });
});
