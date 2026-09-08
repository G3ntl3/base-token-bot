import crypto from "node:crypto";
import type { Hex } from "viem";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Derives a 32-byte key from a secret passphrase using SHA-256.
 */
export function deriveEncryptionKey(secret: string): Buffer {
  if (!secret || secret.trim().length === 0) {
    throw new Error("Encryption secret must not be empty");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Encrypts a private key using AES-256-GCM.
 */
export function encryptPrivateKey(privateKey: string, secret: string): EncryptedData {
  const key = deriveEncryptionKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(privateKey, "utf8", "hex");
  ciphertext += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  return {
    ciphertext,
    iv: iv.toString("hex"),
    authTag,
  };
}

/**
 * Decrypts a private key using AES-256-GCM.
 */
export function decryptPrivateKey(
  ciphertext: string,
  ivHex: string,
  authTagHex: string,
  secret: string
): Hex {
  const key = deriveEncryptionKey(secret);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  if (!decrypted.startsWith("0x")) {
    decrypted = `0x${decrypted}`;
  }

  return decrypted as Hex;
}
