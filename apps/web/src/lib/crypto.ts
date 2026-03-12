import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import {
  choosePaddingBucket,
  type CiphertextEnvelope,
  type MessageRecord
} from "@simplechat/protocol";
import {
  loadStoredDeviceIdentity,
  saveStoredDeviceIdentity,
  type StoredDeviceIdentity
} from "./storage";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DeviceIdentity extends StoredDeviceIdentity {}

export interface DecryptedMessage extends MessageRecord {
  markdown: string;
}

export const ensureDeviceIdentity = async (): Promise<DeviceIdentity> => {
  const existing = await loadStoredDeviceIdentity();
  if (existing) {
    return existing;
  }

  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const identity: DeviceIdentity = {
    deviceId: crypto.randomUUID(),
    label: navigator.userAgent.includes("Mobile") ? "Web Mobile" : "Web Primary",
    privateKey: toBase64Url(privateKey),
    publicKey: toBase64Url(publicKey),
    createdAt: new Date().toISOString()
  };

  await saveStoredDeviceIdentity(identity);
  return identity;
};

export const encryptMarkdownMessage = async (input: {
  conversationId: string;
  senderDeviceId: string;
  markdown: string;
  burnAfterRead: boolean;
  ttlSeconds: number;
  recipients: Array<{ deviceId: string; publicKey: string }>;
}): Promise<CiphertextEnvelope> => {
  const messageId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
  const plaintext = buildPaddedPayload(input.markdown);
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const payloadIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await aesEncrypt(contentKey, payloadIv, encoder.encode(plaintext));
  const ephemeralPrivateKey = x25519.utils.randomPrivateKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

  const wrappedKeys = [];
  for (const recipient of input.recipients) {
    const shared = x25519.getSharedSecret(
      ephemeralPrivateKey,
      fromBase64Url(recipient.publicKey)
    );
    const wrappingKey = hkdf(sha256, shared, undefined, encoder.encode(messageId), 32);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedKey = await aesEncrypt(wrappingKey, wrapIv, contentKey);
    wrappedKeys.push({
      deviceId: recipient.deviceId,
      iv: toBase64Url(wrapIv),
      wrappedKey: toBase64Url(wrappedKey)
    });
  }

  return {
    version: 1,
    messageId,
    conversationId: input.conversationId,
    senderDeviceId: input.senderDeviceId,
    ephemeralPublicKey: toBase64Url(ephemeralPublicKey),
    payloadIv: toBase64Url(payloadIv),
    ciphertext: toBase64Url(ciphertext),
    wrappedKeys,
    paddingBucket: choosePaddingBucket(encoder.encode(plaintext).byteLength),
    burnAfterRead: input.burnAfterRead,
    expiresAt,
    createdAt
  };
};

export const decryptMessage = async (
  identity: DeviceIdentity,
  message: MessageRecord
): Promise<DecryptedMessage | null> => {
  const wrappedKey = message.envelope.wrappedKeys.find(
    (item) => item.deviceId === identity.deviceId
  );
  if (!wrappedKey) {
    return null;
  }

  const shared = x25519.getSharedSecret(
    fromBase64Url(identity.privateKey),
    fromBase64Url(message.envelope.ephemeralPublicKey)
  );
  const wrappingKey = hkdf(
    sha256,
    shared,
    undefined,
    encoder.encode(message.envelope.messageId),
    32
  );
  const contentKey = await aesDecrypt(
    wrappingKey,
    fromBase64Url(wrappedKey.iv),
    fromBase64Url(wrappedKey.wrappedKey)
  );
  const plaintext = await aesDecrypt(
    contentKey,
    fromBase64Url(message.envelope.payloadIv),
    fromBase64Url(message.envelope.ciphertext)
  );
  const payload = JSON.parse(decoder.decode(plaintext)) as {
    markdown: string;
    padding: string;
  };

  return {
    ...message,
    markdown: payload.markdown
  };
};

async function aesEncrypt(
  rawKey: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(rawKey),
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: Uint8Array.from(iv) },
    key,
    Uint8Array.from(plaintext)
  );
  return new Uint8Array(ciphertext);
}

async function aesDecrypt(
  rawKey: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(rawKey),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Uint8Array.from(iv) },
    key,
    Uint8Array.from(ciphertext)
  );
  return new Uint8Array(plaintext);
}

function buildPaddedPayload(markdown: string): string {
  const basePayload = JSON.stringify({ markdown, padding: "" });
  const targetSize = choosePaddingBucket(encoder.encode(basePayload).byteLength);
  const currentSize = encoder.encode(basePayload).byteLength;
  const paddingLength = Math.max(0, targetSize - currentSize);
  return JSON.stringify({
    markdown,
    padding: toBase64Url(crypto.getRandomValues(new Uint8Array(paddingLength)))
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
