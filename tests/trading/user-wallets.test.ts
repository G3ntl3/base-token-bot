import { ExecutionRepository } from "../../src/state/repository";

describe("User Wallets & Dynamic Admins Repository", () => {
  let repository: ExecutionRepository;

  beforeEach(() => {
    repository = new ExecutionRepository(":memory:");
  });

  afterEach(() => {
    repository.close();
  });

  it("stores, retrieves, and updates user wallet records", () => {
    repository.upsertUserWallet({
      userId: 12345,
      address: "0x1111111111111111111111111111111111111111",
      encryptedPrivateKey: "ciphertext123",
      iv: "iv123",
      authTag: "tag123",
      buyAmountEth: 0.05,
    });

    const wallet = repository.getUserWallet(12345);
    expect(wallet).toBeDefined();
    expect(wallet?.userId).toBe(12345);
    expect(wallet?.address).toBe("0x1111111111111111111111111111111111111111");
    expect(wallet?.buyAmountEth).toBe(0.05);

    // Update buy amount
    repository.setUserBuyAmount(12345, 0.1);
    const updated = repository.getUserWallet(12345);
    expect(updated?.buyAmountEth).toBe(0.1);

    // Delete wallet
    const deleted = repository.deleteUserWallet(12345);
    expect(deleted).toBe(true);
    expect(repository.getUserWallet(12345)).toBeUndefined();
  });

  it("tracks dynamic admins", () => {
    expect(repository.isDynamicAdmin(777)).toBe(false);

    repository.addDynamicAdmin(777, 111);
    expect(repository.isDynamicAdmin(777)).toBe(true);
    expect(repository.getAllDynamicAdmins()).toContain(777);

    repository.removeDynamicAdmin(777);
    expect(repository.isDynamicAdmin(777)).toBe(false);
  });

  it("tracks executions per user", () => {
    const exec1 = repository.createExecution("exec-1", "0xToken", 1001);
    const exec2 = repository.createExecution("exec-2", "0xToken", 1002);

    expect(repository.getExecution("exec-1")?.userId).toBe(1001);
    expect(repository.getExecution("exec-2")?.userId).toBe(1002);

    // Transition exec1 to SUBMITTED
    repository.transition("exec-1", "LIQUIDITY_FOUND");
    repository.transition("exec-1", "QUOTE_READY");
    repository.transition("exec-1", "TRANSACTION_READY");
    repository.transition("exec-1", "AUTHORIZED");
    repository.transition("exec-1", "SUBMITTED");

    // Check one-shot per user
    return Promise.all([
      repository.hasCompletedOneShot(1001).then((res) => expect(res).toBe(true)),
      repository.hasCompletedOneShot(1002).then((res) => expect(res).toBe(false)),
    ]);
  });
});
