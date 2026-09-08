import { ExecutionRepository } from "../../src/state/repository";

describe("ExecutionRepository duplicate prevention", () => {
  let repo: ExecutionRepository;

  beforeEach(() => {
    repo = new ExecutionRepository(":memory:");
  });

  afterEach(() => {
    repo.close();
  });

  it("does not report an execution key as used before it reaches AUTHORIZED", async () => {
    const id = "exec-1";
    repo.createExecution(id, "0xToken");
    repo.transition(id, "LIQUIDITY_FOUND");
    repo.transition(id, "QUOTE_READY");
    repo.transition(id, "TRANSACTION_READY", { executionKey: "key-abc" });

    expect(await repo.hasExecutionKey("key-abc")).toBe(false);
  });

  it("reports an execution key as used once AUTHORIZED", async () => {
    const id = "exec-2";
    repo.createExecution(id, "0xToken");
    repo.transition(id, "LIQUIDITY_FOUND");
    repo.transition(id, "QUOTE_READY");
    repo.transition(id, "TRANSACTION_READY", { executionKey: "key-xyz" });
    repo.transition(id, "AUTHORIZED");

    expect(await repo.hasExecutionKey("key-xyz")).toBe(true);
  });

  it("tracks one-shot completion only after SUBMITTED/CONFIRMED", async () => {
    const id = "exec-3";
    repo.createExecution(id, "0xToken");
    expect(await repo.hasCompletedOneShot()).toBe(false);

    repo.transition(id, "LIQUIDITY_FOUND");
    repo.transition(id, "QUOTE_READY");
    repo.transition(id, "TRANSACTION_READY");
    repo.transition(id, "AUTHORIZED");
    expect(await repo.hasCompletedOneShot()).toBe(false);

    repo.transition(id, "SUBMITTED");
    expect(await repo.hasCompletedOneShot()).toBe(true);
  });

  it("throws on invalid state transitions rather than silently allowing them", () => {
    const id = "exec-4";
    repo.createExecution(id, "0xToken");
    expect(() => repo.transition(id, "AUTHORIZED")).toThrow();
  });

  it("survives being re-instantiated against the same database (restart simulation)", async () => {
    const path = require("node:path").join(require("node:os").tmpdir(), `bot-test-${Date.now()}.sqlite`);
    const first = new ExecutionRepository(path);
    first.createExecution("exec-restart", "0xToken");
    first.transition("exec-restart", "LIQUIDITY_FOUND");
    first.transition("exec-restart", "QUOTE_READY");
    first.transition("exec-restart", "TRANSACTION_READY", { executionKey: "restart-key" });
    first.transition("exec-restart", "AUTHORIZED");
    first.close();

    const second = new ExecutionRepository(path);
    expect(await second.hasExecutionKey("restart-key")).toBe(true);
    second.close();
    require("node:fs").rmSync(path, { force: true });
    require("node:fs").rmSync(path + "-wal", { force: true });
    require("node:fs").rmSync(path + "-shm", { force: true });
  });
});
