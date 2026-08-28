
/**
 * CryptoService handles End-to-End Encryption (E2EE) using the Web Crypto API.
 * It provides methods for key generation, key exchange (ECDH), and message encryption (AES-GCM).
 */

const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KEY_MODULUS_LENGTH = 256;
const PBKDF2_ITERATIONS = 100000;

export interface KeyPairPackage {
  publicKey: string;
  encryptedPrivateKey: string;
  salt: string;
}

export class CryptoService {
  // --- Binary Conversions ---
  
  private static bufferToBase64(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }

  private static base64ToBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // --- Identity Key Management ---

  /**
   * Generates a new ECDH key pair and encrypts the private key with a passphrase.
   */
  static async generateIdentityKeyPair(passphrase: string): Promise<KeyPairPackage> {
    // 1. Generate ECDH Key Pair
    const keyPair = await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );

    // 2. Export Keys
    const publicKeyBuffer = await window.crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyBuffer = await window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    // 3. Derive a wrapping key from the passphrase
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const wrappingKey = await this.derivePassphraseKey(passphrase, salt);

    // 4. Encrypt the private key
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encryptedPrivateKeyBuffer = await window.crypto.subtle.encrypt(
      { name: ENCRYPTION_ALGORITHM, iv },
      wrappingKey,
      privateKeyBuffer
    );

    // 5. Package with IV prepended to the ciphertext
    const fullEncryptedPrivate = new Uint8Array(iv.length + encryptedPrivateKeyBuffer.byteLength);
    fullEncryptedPrivate.set(iv);
    fullEncryptedPrivate.set(new Uint8Array(encryptedPrivateKeyBuffer), iv.length);

    return {
      publicKey: this.bufferToBase64(publicKeyBuffer),
      encryptedPrivateKey: this.bufferToBase64(fullEncryptedPrivate.buffer),
      salt: this.bufferToBase64(salt.buffer)
    };
  }

  /**
   * Decrypts the private key from Firestore using the user's passphrase.
   */
  static async decryptPrivateKey(encryptedBase64: string, saltBase64: string, passphrase: string): Promise<CryptoKey> {
    const fullData = new Uint8Array(this.base64ToBuffer(encryptedBase64));
    const salt = new Uint8Array(this.base64ToBuffer(saltBase64));
    
    const iv = fullData.slice(0, 12);
    const ciphertext = fullData.slice(12);

    const wrappingKey = await this.derivePassphraseKey(passphrase, salt);

    const privateKeyBuffer = await window.crypto.subtle.decrypt(
      { name: ENCRYPTION_ALGORITHM, iv },
      wrappingKey,
      ciphertext
    );

    return await window.crypto.subtle.importKey(
      'pkcs8',
      privateKeyBuffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
  }

  private static async derivePassphraseKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const passphraseKey = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      passphraseKey,
      { name: ENCRYPTION_ALGORITHM, length: KEY_MODULUS_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // --- Message Encryption ---

  /**
   * Derives a shared symmetric key between two participants using ECDH.
   */
  static async deriveSharedSecret(myPrivateKey: CryptoKey, theirPublicKeyBase64: string): Promise<CryptoKey> {
    const theirPublicKeyBuffer = this.base64ToBuffer(theirPublicKeyBase64);
    const theirPublicKey = await window.crypto.subtle.importKey(
      'spki',
      theirPublicKeyBuffer,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );

    return await window.crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPublicKey },
      myPrivateKey,
      { name: ENCRYPTION_ALGORITHM, length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypts plaintext using AES-GCM.
   */
  static async encrypt(plaintext: string, sharedKey: CryptoKey): Promise<{ ciphertext: string, iv: string }> {
    const encoder = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    const ciphertextBuffer = await window.crypto.subtle.encrypt(
      { name: ENCRYPTION_ALGORITHM, iv },
      sharedKey,
      encoder.encode(plaintext)
    );

    return {
      ciphertext: this.bufferToBase64(ciphertextBuffer),
      iv: this.bufferToBase64(iv.buffer)
    };
  }

  /**
   * Decrypts ciphertext using AES-GCM.
   */
  static async decrypt(ciphertextBase64: string, ivBase64: string, sharedKey: CryptoKey): Promise<string> {
    const decoder = new TextDecoder();
    const ciphertext = this.base64ToBuffer(ciphertextBase64);
    const iv = new Uint8Array(this.base64ToBuffer(ivBase64));

    const plaintextBuffer = await window.crypto.subtle.decrypt(
      { name: ENCRYPTION_ALGORITHM, iv },
      sharedKey,
      ciphertext
    );

    return decoder.decode(plaintextBuffer);
  }
}
