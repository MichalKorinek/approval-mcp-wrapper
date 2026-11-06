import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { StorageCodec } from '@approval-mcp/contracts';

const prefix = 'amcp-sealed-v1:';

/** A separate HKDF key domain from legacy credential and VAPID encryption. */
export class StorageCipher implements StorageCodec {
  private readonly key: Buffer;
  constructor(masterKey: Uint8Array, private readonly vaultId: string) {
    if (masterKey.byteLength !== 32) throw new Error('Invalid storage key');
    this.key = Buffer.from(hkdfSync('sha256', masterKey, vaultId, 'approval-mcp:storage:v1', 32));
  }
  encode(context: string, plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${this.vaultId}:${context}`));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return prefix + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }
  decode(context: string, ciphertext: string): string {
    if (!ciphertext.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(ciphertext.slice(prefix.length))) {
      throw new Error('Unencrypted or invalid storage record');
    }
    const bytes = Buffer.from(ciphertext.slice(prefix.length), 'base64url');
    if (bytes.length < 28 || bytes.toString('base64url') !== ciphertext.slice(prefix.length)) throw new Error('Invalid storage record');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${this.vaultId}:${context}`));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
  destroy(): void { this.key.fill(0); }
}

export function encodeLines(codec: StorageCodec, context: string, source: string): string {
  return source.split('\n').map((line) => line === '' ? '' : codec.encode(context, line)).join('\n');
}
export function decodeLines(codec: StorageCodec, context: string, source: string): string {
  return source.split('\n').map((line) => line === '' ? '' : codec.decode(context, line)).join('\n');
}
