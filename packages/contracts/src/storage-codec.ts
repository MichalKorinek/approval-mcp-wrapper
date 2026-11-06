/** Authenticated, path-bound records. Implementations must reject plaintext. */
export interface StorageCodec {
  encode(context: string, plaintext: string): string;
  decode(context: string, ciphertext: string): string;
}
