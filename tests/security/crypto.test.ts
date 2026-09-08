import { encryptPrivateKey, decryptPrivateKey, deriveEncryptionKey } from "../../src/security/crypto";

describe("AES-256-GCM Crypto Module", () => {
  const testSecret = "my_super_secret_test_passphrase_12345";
  const testPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  it("derives a 32-byte key from secret", () => {
    const key = deriveEncryptionKey(testSecret);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it("throws if secret is empty", () => {
    expect(() => deriveEncryptionKey("")).toThrow("Encryption secret must not be empty");
    expect(() => deriveEncryptionKey("   ")).toThrow("Encryption secret must not be empty");
  });

  it("encrypts and decrypts private key correctly", () => {
    const encrypted = encryptPrivateKey(testPrivateKey, testSecret);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();
    expect(encrypted.ciphertext).not.toBe(testPrivateKey);

    const decrypted = decryptPrivateKey(
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      testSecret
    );
    expect(decrypted.toLowerCase()).toBe(testPrivateKey.toLowerCase());
  });

  it("produces unique IVs and ciphertexts for identical plaintexts", () => {
    const enc1 = encryptPrivateKey(testPrivateKey, testSecret);
    const enc2 = encryptPrivateKey(testPrivateKey, testSecret);

    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

    // Both should still decrypt to the exact same key
    expect(decryptPrivateKey(enc1.ciphertext, enc1.iv, enc1.authTag, testSecret)).toBe(
      testPrivateKey
    );
    expect(decryptPrivateKey(enc2.ciphertext, enc2.iv, enc2.authTag, testSecret)).toBe(
      testPrivateKey
    );
  });

  it("fails decryption if wrong secret is used", () => {
    const encrypted = encryptPrivateKey(testPrivateKey, testSecret);
    expect(() =>
      decryptPrivateKey(encrypted.ciphertext, encrypted.iv, encrypted.authTag, "wrong_secret_passphrase")
    ).toThrow();
  });

  it("fails decryption if ciphertext or auth tag is tampered with", () => {
    const encrypted = encryptPrivateKey(testPrivateKey, testSecret);
    const tamperedTag = (Buffer.from(encrypted.authTag, "hex")[0] ^ 0xff).toString(16) + encrypted.authTag.slice(2);
    expect(() =>
      decryptPrivateKey(encrypted.ciphertext, encrypted.iv, tamperedTag, testSecret)
    ).toThrow();
  });
});
