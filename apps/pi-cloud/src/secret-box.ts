import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const prefix = "v1.";
const keyLength = 32;
const ivLength = 12;
const tagLength = 16;

class WrongSecretKey extends Error {}

// Encrypts Environment secrets at rest with AES-GCM (ADR 0034). The context,
// such as the Environment's id, keeps a sealed value from being moved to
// another row.
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== keyLength) {
      throw new WrongSecretKey(
        `the secret key must be ${String(keyLength)} bytes, base64 encoded`,
      );
    }

    this.#key = key;
  }

  static isSealed(text: string): boolean {
    return text.startsWith(prefix);
  }

  seal(text: string, context: string): string {
    const iv = randomBytes(ivLength);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(context));

    const sealed = Buffer.concat([
      iv,
      cipher.update(text, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    return `${prefix}${sealed.toString("base64url")}`;
  }

  open(text: string, context: string): string {
    const sealed = Buffer.from(text.slice(prefix.length), "base64url");
    const iv = sealed.subarray(0, ivLength);
    const tag = sealed.subarray(sealed.length - tagLength);

    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(ivLength, sealed.length - tagLength)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new WrongSecretKey(
        "the secret key doesn't open this database's secrets",
      );
    }
  }
}

export function parseSecretKey(text: string): Buffer {
  return Buffer.from(text.trim(), "base64");
}

// Without PI_CLOUD_SECRET_KEY, a laptop keeps its key in a file next to the
// database, made on first start.
export function fileSecretKey(path: string): Buffer {
  try {
    return parseSecretKey(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const key = randomBytes(keyLength);

  writeFileSync(path, `${key.toString("base64")}\n`, {
    mode: 0o600,
    flag: "wx",
  });

  return key;
}
