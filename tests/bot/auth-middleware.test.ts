import { createAdminMiddleware, superAdminOnly } from "../../src/bot/middleware/auth";
import { ExecutionRepository } from "../../src/state/repository";

function makeCtx(userId: number | undefined) {
  return {
    from: userId ? { id: userId } : undefined,
    chat: { id: 999 },
    reply: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe("auth middleware", () => {
  let repository: ExecutionRepository;

  beforeEach(() => {
    repository = new ExecutionRepository(":memory:");
  });

  afterEach(() => {
    repository.close();
  });

  describe("createAdminMiddleware", () => {
    it("allows a configured .env admin id through (111, 222 set in test env)", async () => {
      const adminMiddleware = createAdminMiddleware(repository);
      const ctx = makeCtx(111);
      const next = jest.fn().mockResolvedValue(undefined);
      await adminMiddleware(ctx, next);
      expect(next).toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it("allows a dynamic admin added to repository", async () => {
      repository.addDynamicAdmin(555, 111);
      const adminMiddleware = createAdminMiddleware(repository);
      const ctx = makeCtx(555);
      const next = jest.fn().mockResolvedValue(undefined);
      await adminMiddleware(ctx, next);
      expect(next).toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it("blocks an unapproved user id", async () => {
      const adminMiddleware = createAdminMiddleware(repository);
      const ctx = makeCtx(999999);
      const next = jest.fn().mockResolvedValue(undefined);
      await adminMiddleware(ctx, next);
      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Unauthorized"));
    });
  });

  describe("superAdminOnly", () => {
    it("allows static .env super admin through", async () => {
      const ctx = makeCtx(111);
      const next = jest.fn().mockResolvedValue(undefined);
      await superAdminOnly(ctx, next);
      expect(next).toHaveBeenCalled();
    });

    it("blocks dynamic admin from super admin commands", async () => {
      repository.addDynamicAdmin(555, 111);
      const ctx = makeCtx(555);
      const next = jest.fn().mockResolvedValue(undefined);
      await superAdminOnly(ctx, next);
      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("restricted"));
    });
  });
});
