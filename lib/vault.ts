import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.ts";

const TAG = Buffer.from("AES.GCM.V1");
const AAD = Buffer.from("AES256GCM");
const IV_LENGTH = 16;

function key(): Buffer {
  return Buffer.from(config.linearEncryptionKey, "base64");
}

function encodeTag(tag: Buffer): Buffer {
  return Buffer.concat([Buffer.from([1, tag.length]), tag]);
}

export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([encodeTag(TAG), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(payload: Buffer): string {
  if (payload[0] !== 1) throw new Error("unsupported ciphertext format");
  let offset = 1;
  let tagLength = payload[offset];
  offset += 1;
  if (tagLength >= 128) {
    const lengthBytes = tagLength - 128;
    tagLength = payload.subarray(offset, offset + lengthBytes).reduce((acc, byte) => acc * 256 + byte, 0);
    offset += lengthBytes;
  }
  const tag = payload.subarray(offset, offset + tagLength);
  if (!tag.equals(TAG)) throw new Error(`unknown cipher tag ${tag.toString()}`);
  offset += tagLength;

  const iv = payload.subarray(offset, offset + IV_LENGTH);
  const authTag = payload.subarray(offset + IV_LENGTH, offset + IV_LENGTH + 16);
  const ciphertext = payload.subarray(offset + IV_LENGTH + 16);

  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
