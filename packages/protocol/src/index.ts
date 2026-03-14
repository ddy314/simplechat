export const TTL_PRESETS = [
  { label: "10 minutes", value: 10 * 60 },
  { label: "1 hour", value: 60 * 60 },
  { label: "1 day", value: 24 * 60 * 60 },
  { label: "7 days", value: 7 * 24 * 60 * 60 }
] as const;

export const PADDING_BUCKETS = [512, 1024, 2048, 4096, 8192, 16384] as const;

export type TtlPresetValue = (typeof TTL_PRESETS)[number]["value"];

export interface OAuthProviderConfig {
  id: "local" | "google" | "github";
  name: string;
  enabled: boolean;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
}

export interface LocalAuthInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface DeviceRecord {
  id: string;
  label: string;
  publicKey: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface FriendSummary {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  conversationId: string | null;
}

export interface FriendRequestSummary {
  id: string;
  direction: "incoming" | "outgoing";
  counterparty: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface WorkspaceSnapshot {
  friends: FriendSummary[];
  requests: FriendRequestSummary[];
  conversations: ConversationSummary[];
}

export interface ConversationSummary {
  id: string;
  kind: "direct";
  counterpart: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  expiresInSeconds: number;
  lastMessageAt: string | null;
}

export interface WrappedKeyEnvelope {
  deviceId: string;
  iv: string;
  wrappedKey: string;
}

export interface CiphertextEnvelope {
  version: 1;
  messageId: string;
  conversationId: string;
  senderDeviceId: string;
  ephemeralPublicKey: string;
  payloadIv: string;
  ciphertext: string;
  wrappedKeys: WrappedKeyEnvelope[];
  paddingBucket: number;
  burnAfterRead: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  senderUserId: string;
  senderDisplayName: string;
  senderAvatarUrl: string | null;
  createdAt: string;
  expiresAt: string;
  burnAfterRead: boolean;
  envelope: CiphertextEnvelope;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  participants: SessionUser[];
  participantDevices: Array<{
    userId: string;
    deviceId: string;
    label: string;
    publicKey: string;
  }>;
  messages: MessageRecord[];
}

export interface SendMessageInput {
  envelope: CiphertextEnvelope;
}

export const isoNow = (): string => new Date().toISOString();

export const clampTtl = (seconds: number): number => {
  if (seconds <= 0) {
    return TTL_PRESETS[0].value;
  }

  return Math.min(seconds, TTL_PRESETS[TTL_PRESETS.length - 1].value);
};

export const choosePaddingBucket = (size: number): number => {
  for (const bucket of PADDING_BUCKETS) {
    if (size <= bucket) {
      return bucket;
    }
  }

  return PADDING_BUCKETS[PADDING_BUCKETS.length - 1];
};
