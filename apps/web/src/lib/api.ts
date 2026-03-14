import type {
  ConversationDetail,
  ConversationSummary,
  DeviceRecord,
  FriendRequestSummary,
  FriendSummary,
  LocalAuthInput,
  OAuthProviderConfig,
  SessionResponse
} from "@simplechat/protocol";

const jsonHeaders = {
  "Content-Type": "application/json"
};

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        ...jsonHeaders,
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `Request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  getProviders(): Promise<{ providers: OAuthProviderConfig[] }> {
    return this.request("/auth/providers", { method: "GET" });
  }

  getSession(): Promise<SessionResponse> {
    return this.request("/auth/session", { method: "GET" });
  }

  register(input: LocalAuthInput): Promise<{ ok: boolean }> {
    return this.request("/auth/register", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  login(input: LocalAuthInput): Promise<{ ok: boolean }> {
    return this.request("/auth/login", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request("/auth/logout", { method: "POST" });
  }

  getDevices(): Promise<{ devices: DeviceRecord[] }> {
    return this.request("/api/me/devices", { method: "GET" });
  }

  registerDevice(input: {
    deviceId: string;
    label: string;
    publicKey: string;
  }): Promise<{ device: DeviceRecord }> {
    return this.request("/api/me/devices/register", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  getFriends(): Promise<{ friends: FriendSummary[] }> {
    return this.request("/api/friends", { method: "GET" });
  }

  getFriendRequests(): Promise<{ requests: FriendRequestSummary[] }> {
    return this.request("/api/friends/requests", { method: "GET" });
  }

  createFriendRequest(email: string): Promise<{ ok: boolean }> {
    return this.request("/api/friends/requests", {
      method: "POST",
      body: JSON.stringify({ email })
    });
  }

  acceptFriendRequest(requestId: string): Promise<{ ok: boolean; conversationId: string }> {
    return this.request(`/api/friends/requests/${requestId}/accept`, {
      method: "POST"
    });
  }

  getConversations(): Promise<{ conversations: ConversationSummary[] }> {
    return this.request("/api/conversations", { method: "GET" });
  }

  getConversation(conversationId: string): Promise<ConversationDetail> {
    return this.request(`/api/conversations/${conversationId}`, { method: "GET" });
  }

  sendMessage(conversationId: string, envelope: unknown): Promise<{ ok: boolean }> {
    return this.request(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ envelope })
    });
  }

  markMessageRead(conversationId: string, messageId: string): Promise<{ ok: boolean }> {
    return this.request(
      `/api/conversations/${conversationId}/messages/${messageId}/read`,
      { method: "POST" }
    );
  }
}

export const api = new ApiClient(
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787"
);
