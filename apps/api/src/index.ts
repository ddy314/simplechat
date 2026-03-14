import { Hono } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  clampTtl,
  type CiphertextEnvelope,
  type ConversationDetail,
  type ConversationSummary,
  type DeviceRecord,
  type FriendRequestSummary,
  type FriendSummary,
  type LocalAuthInput,
  type OAuthProviderConfig,
  type SessionResponse,
  type WorkspaceSnapshot
} from "@simplechat/protocol";

type Bindings = {
  DB: D1Database;
  MESSAGE_BLOB: R2Bucket;
  APP_ORIGIN: string;
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_REDIRECT_URI?: string;
};

type SessionContext = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
};

type Variables = {
  session: SessionContext | null;
};

type ProviderName = "google" | "github";

interface OAuthStatePayload {
  provider: ProviderName;
  state: string;
  createdAt: number;
}

interface ProviderProfile {
  subject: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

interface MessageIndexRow {
  id: string;
  sender_user_id: string;
  sender_display_name: string;
  sender_avatar_url: string | null;
  created_at: string;
  expires_at: string;
  burn_after_read: number;
  r2_key: string;
}

const SESSION_COOKIE = "simplechat_session";
const OAUTH_STATE_COOKIE = "simplechat_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const PASSWORD_ITERATIONS = 120_000;
const MAX_ENVELOPE_BYTES = 8 * 1024;
const MAX_ACTIVE_R2_BYTES = 128 * 1024 * 1024;
const MAX_R2_WRITES_PER_DAY = 5_000;
const MAX_R2_READS_PER_DAY = 20_000;
const MAX_MESSAGES_PER_USER_PER_DAY = 250;

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use(
  "/*",
  cors({
    origin: (origin, c) => origin ?? c.env.APP_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400
  })
);

app.use("*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    c.set("session", null);
    return next();
  }

  const tokenHash = await sha256Hex(token + c.env.SESSION_SECRET);
  const session = await c.env.DB.prepare(
    `
      SELECT sessions.id AS session_id, users.id AS user_id, users.email, users.display_name, users.avatar_url
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2
    `
  )
    .bind(tokenHash, new Date().toISOString())
    .first<{
      session_id: string;
      user_id: string;
      email: string;
      display_name: string;
      avatar_url: string | null;
    }>();

  if (!session) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    c.set("session", null);
    return next();
  }

  c.set("session", {
    sessionId: session.session_id,
    userId: session.user_id,
    email: session.email,
    displayName: session.display_name,
    avatarUrl: session.avatar_url
  });

  await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), session.session_id)
    .run();

  return next();
});

app.get("/health", (c) => c.json({ ok: true, now: new Date().toISOString() }));

app.get("/auth/providers", (c) => {
  const providers: OAuthProviderConfig[] = [
    {
      id: "local",
      name: "Email & Password",
      enabled: true
    },
    {
      id: "google",
      name: "Google",
      enabled: Boolean(
        c.env.GOOGLE_CLIENT_ID &&
          c.env.GOOGLE_CLIENT_SECRET &&
          c.env.GOOGLE_REDIRECT_URI
      )
    },
    {
      id: "github",
      name: "GitHub",
      enabled: Boolean(
        c.env.GITHUB_CLIENT_ID &&
          c.env.GITHUB_CLIENT_SECRET &&
          c.env.GITHUB_REDIRECT_URI
      )
    }
  ];

  return c.json({ providers });
});

app.get("/auth/session", (c) => {
  const session = c.get("session");
  const payload: SessionResponse = session
    ? {
        authenticated: true,
        user: {
          id: session.userId,
          email: session.email,
          displayName: session.displayName,
          avatarUrl: session.avatarUrl
        }
      }
    : { authenticated: false, user: null };
  return c.json(payload);
});

app.post("/auth/register", async (c) => {
  const body = await c.req.json<LocalAuthInput>();
  const email = normalizeEmail(body.email);
  const password = body.password?.trim();
  const displayName = body.displayName?.trim() || email.split("@")[0];

  if (!email || !password || password.length < 10) {
    return c.json({ error: "Email and a password of at least 10 characters are required." }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?1")
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    return c.json({ error: "This email is already registered." }, 409);
  }

  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await hashPassword(password, saltBytes, PASSWORD_ITERATIONS);
  try {
    await c.env.DB.prepare(
      `
        INSERT INTO users (id, email, display_name, avatar_url, created_at, updated_at)
        VALUES (?1, ?2, ?3, NULL, ?4, ?4)
      `
    )
      .bind(userId, email, displayName, now)
      .run();

    await c.env.DB.prepare(
      `
        INSERT INTO user_credentials (user_id, password_hash, password_salt, password_iterations, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      `
    )
      .bind(userId, passwordHash, toBase64Url(saltBytes), PASSWORD_ITERATIONS, now)
      .run();
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId).run();
    throw error;
  }

  await createSession(c, userId);
  return c.json({ ok: true }, 201);
});

app.post("/auth/login", async (c) => {
  const body = await c.req.json<LocalAuthInput>();
  const email = normalizeEmail(body.email);
  const password = body.password?.trim();
  if (!email || !password) {
    return c.json({ error: "Email and password are required." }, 400);
  }

  const credential = await c.env.DB.prepare(
    `
      SELECT users.id AS user_id, uc.password_hash, uc.password_salt, uc.password_iterations
      FROM users
      JOIN user_credentials uc ON uc.user_id = users.id
      WHERE lower(users.email) = ?1
    `
  )
    .bind(email)
    .first<{
      user_id: string;
      password_hash: string;
      password_salt: string;
      password_iterations: number;
    }>();

  if (!credential) {
    return c.json({ error: "Invalid email or password." }, 401);
  }

  const computedHash = await hashPassword(
    password,
    fromBase64Url(credential.password_salt),
    credential.password_iterations
  );
  if (computedHash !== credential.password_hash) {
    return c.json({ error: "Invalid email or password." }, 401);
  }

  await createSession(c, credential.user_id);
  return c.json({ ok: true });
});

app.get("/auth/oauth/:provider/start", async (c) => {
  const provider = c.req.param("provider") as ProviderName;
  const redirectUrl = getAuthorizationUrl(provider, c.env);

  if (!redirectUrl) {
    return c.json({ error: "Provider is not configured." }, 400);
  }

  const state = randomToken();
  const statePayload: OAuthStatePayload = {
    provider,
    state,
    createdAt: Date.now()
  };

  setCookie(c, OAUTH_STATE_COOKIE, btoa(JSON.stringify(statePayload)), {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
    maxAge: 600
  });

  redirectUrl.searchParams.set("state", state);
  return c.redirect(redirectUrl.toString(), 302);
});

app.get("/auth/oauth/:provider/callback", async (c) => {
  const provider = c.req.param("provider") as ProviderName;
  const code = c.req.query("code");
  const state = c.req.query("state");
  const stateCookie = getCookie(c, OAUTH_STATE_COOKIE);

  if (!code || !state || !stateCookie) {
    return c.text("OAuth callback is missing code or state.", 400);
  }

  const decodedState = safeParseState(stateCookie);
  if (!decodedState || decodedState.provider !== provider || decodedState.state !== state) {
    return c.text("OAuth state validation failed.", 400);
  }

  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });

  const profile = await exchangeCodeForProfile(provider, code, c.env);
  if (!profile) {
    return c.text("Failed to fetch provider profile.", 400);
  }

  const userId = await findOrCreateUser(c.env.DB, provider, profile);
  await createSession(c, userId);

  return c.redirect(c.env.APP_ORIGIN, 302);
});

app.post("/auth/logout", requireSession, async (c) => {
  const session = c.get("session");
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1")
    .bind(session!.sessionId)
    .run();

  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me/devices", requireSession, async (c) => {
  const session = c.get("session")!;
  const result = await c.env.DB.prepare(
    `
      SELECT id, label, public_key, created_at, last_seen_at
      FROM devices
      WHERE user_id = ?1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC
    `
  )
    .bind(session.userId)
    .all<{
      id: string;
      label: string;
      public_key: string;
      created_at: string;
      last_seen_at: string;
    }>();

  const devices: DeviceRecord[] = result.results.map((row) => ({
    id: row.id,
    label: row.label,
    publicKey: row.public_key,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  }));

  return c.json({ devices });
});

app.post("/api/me/devices/register", requireSession, async (c) => {
  const session = c.get("session")!;
  const body = await c.req.json<{ deviceId?: string; label?: string; publicKey?: string }>();

  if (!body.label || !body.publicKey) {
    return c.json({ error: "Device label and publicKey are required." }, 400);
  }

  const deviceId = body.deviceId ?? crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `
      INSERT INTO devices (id, user_id, label, public_key, created_at, last_seen_at, revoked_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        public_key = excluded.public_key,
        last_seen_at = excluded.last_seen_at,
        revoked_at = NULL
    `
  )
    .bind(deviceId, session.userId, body.label, body.publicKey, now)
    .run();

  return c.json({
    device: {
      id: deviceId,
      label: body.label,
      publicKey: body.publicKey,
      createdAt: now,
      lastSeenAt: now
    }
  });
});

app.get("/api/friends", requireSession, async (c) => {
  const session = c.get("session")!;
  const friends = await listFriends(c.env.DB, session.userId);
  return c.json({ friends });
});

app.get("/api/friends/requests", requireSession, async (c) => {
  const session = c.get("session")!;
  const requests = await listFriendRequests(c.env.DB, session.userId);
  return c.json({ requests });
});

app.get("/api/workspace", requireSession, async (c) => {
  const session = c.get("session")!;
  const [friends, requests, conversations] = await Promise.all([
    listFriends(c.env.DB, session.userId),
    listFriendRequests(c.env.DB, session.userId),
    listConversations(c.env.DB, session.userId)
  ]);

  return c.json({
    friends,
    requests,
    conversations
  } satisfies WorkspaceSnapshot);
});

app.post("/api/friends/requests", requireSession, async (c) => {
  const session = c.get("session")!;
  const body = await c.req.json<{ email?: string }>();
  const email = body.email?.trim().toLowerCase();

  if (!email) {
    return c.json({ error: "Friend email is required." }, 400);
  }

  if (email === session.email.toLowerCase()) {
    return c.json({ error: "You cannot add yourself." }, 400);
  }

  const target = await c.env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?1")
    .bind(email)
    .first<{ id: string }>();

  if (!target) {
    return c.json({ error: "No user found for that email." }, 404);
  }

  const existing = await c.env.DB.prepare(
    `
      SELECT id, status
      FROM friend_requests
      WHERE (from_user_id = ?1 AND to_user_id = ?2)
         OR (from_user_id = ?2 AND to_user_id = ?1)
    `
  )
    .bind(session.userId, target.id)
    .first<{ id: string; status: string }>();

  if (existing?.status === "pending") {
    return c.json({ error: "A friend request already exists." }, 409);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `
      INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at, responded_at)
      VALUES (?1, ?2, ?3, 'pending', ?4, NULL)
    `
  )
    .bind(crypto.randomUUID(), session.userId, target.id, now)
    .run();

  return c.json({ ok: true }, 201);
});

app.post("/api/friends/requests/:requestId/accept", requireSession, async (c) => {
  const session = c.get("session")!;
  const requestId = c.req.param("requestId");
  const request = await c.env.DB.prepare(
    `
      SELECT id, from_user_id, to_user_id, status
      FROM friend_requests
      WHERE id = ?1
    `
  )
    .bind(requestId)
    .first<{
      id: string;
      from_user_id: string;
      to_user_id: string;
      status: string;
    }>();

  if (!request || request.to_user_id !== session.userId) {
    return c.json({ error: "Request not found." }, 404);
  }

  if (request.status !== "pending") {
    return c.json({ error: "Request is no longer pending." }, 409);
  }

  const now = new Date().toISOString();
  const conversationId = await ensureDirectConversation(c.env.DB, [
    request.from_user_id,
    request.to_user_id
  ]);

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE friend_requests SET status = 'accepted', responded_at = ?1 WHERE id = ?2"
    ).bind(now, request.id),
    c.env.DB.prepare(
      `
        INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at)
        VALUES (?1, ?2, ?3), (?1, ?4, ?3)
      `
    ).bind(conversationId, request.from_user_id, now, request.to_user_id)
  ]);

  return c.json({ ok: true, conversationId });
});

app.get("/api/conversations", requireSession, async (c) => {
  const session = c.get("session")!;
  const conversations = await listConversations(c.env.DB, session.userId);
  return c.json({ conversations });
});

app.get("/api/conversations/:conversationId", requireSession, async (c) => {
  const session = c.get("session")!;
  const conversationId = c.req.param("conversationId");
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM conversation_members WHERE conversation_id = ?1 AND user_id = ?2"
  )
    .bind(conversationId, session.userId)
    .first();

  if (!member) {
    return c.json({ error: "Conversation not found." }, 404);
  }

  await incrementUsageCounter(c.env.DB, "r2_reads_day", 1, MAX_R2_READS_PER_DAY);
  const detail = await loadConversationDetail(
    c.env.DB,
    c.env.MESSAGE_BLOB,
    conversationId,
    session.userId
  );
  return c.json(detail satisfies ConversationDetail);
});

app.post("/api/conversations/:conversationId/messages", requireSession, async (c) => {
  const session = c.get("session")!;
  const conversationId = c.req.param("conversationId");
  const body = await c.req.json<{ envelope?: CiphertextEnvelope }>();
  const envelope = body.envelope;

  if (!envelope) {
    return c.json({ error: "Message envelope is required." }, 400);
  }

  if (envelope.conversationId !== conversationId || !validateEnvelope(envelope)) {
    return c.json({ error: "Envelope is invalid." }, 400);
  }

  const device = await c.env.DB.prepare(
    `
      SELECT id
      FROM devices
      WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL
    `
  )
    .bind(envelope.senderDeviceId, session.userId)
    .first();

  if (!device) {
    return c.json({ error: "Device is not registered to the current user." }, 403);
  }

  const member = await c.env.DB.prepare(
    "SELECT 1 FROM conversation_members WHERE conversation_id = ?1 AND user_id = ?2"
  )
    .bind(conversationId, session.userId)
    .first();

  if (!member) {
    return c.json({ error: "Conversation not found." }, 404);
  }

  const ttlSeconds = clampTtl(
    Math.round((new Date(envelope.expiresAt).getTime() - Date.now()) / 1000)
  );
  const normalizedEnvelope: CiphertextEnvelope = {
    ...envelope,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
  };

  const serialized = JSON.stringify(normalizedEnvelope);
  if (serialized.length > MAX_ENVELOPE_BYTES) {
    return c.json({ error: "Encrypted message exceeds the free-tier storage cap." }, 400);
  }

  const quotaCheck = await assertR2QuotaAvailable(c.env.DB, session.userId, serialized.length);
  if (quotaCheck) {
    return c.json({ error: quotaCheck }, 429);
  }

  const objectKey = `messages/${conversationId}/${normalizedEnvelope.messageId}.json`;

  await c.env.MESSAGE_BLOB.put(objectKey, serialized, {
    httpMetadata: { contentType: "application/octet-stream" }
  });

  await incrementUsageCounter(c.env.DB, "r2_writes_day", 1, MAX_R2_WRITES_PER_DAY);

  await c.env.DB.prepare(
    `
      INSERT INTO messages (
        id, conversation_id, sender_user_id, sender_device_id, r2_key, ciphertext_bytes, burn_after_read, expires_at, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `
  )
    .bind(
      normalizedEnvelope.messageId,
      conversationId,
      session.userId,
      normalizedEnvelope.senderDeviceId,
      objectKey,
      serialized.length,
      normalizedEnvelope.burnAfterRead ? 1 : 0,
      normalizedEnvelope.expiresAt,
      normalizedEnvelope.createdAt
    )
    .run();

  return c.json({ ok: true, messageId: normalizedEnvelope.messageId }, 201);
});

app.post("/api/conversations/:conversationId/messages/:messageId/read", requireSession, async (c) => {
  const session = c.get("session")!;
  const conversationId = c.req.param("conversationId");
  const messageId = c.req.param("messageId");
  const row = await c.env.DB.prepare(
    `
      SELECT messages.id, messages.r2_key, messages.burn_after_read
      FROM messages
      JOIN conversation_members ON conversation_members.conversation_id = messages.conversation_id
      WHERE messages.id = ?1 AND messages.conversation_id = ?2 AND conversation_members.user_id = ?3
    `
  )
    .bind(messageId, conversationId, session.userId)
    .first<{ id: string; r2_key: string; burn_after_read: number }>();

  if (!row) {
    return c.json({ error: "Message not found." }, 404);
  }

  if (row.burn_after_read) {
    await c.env.MESSAGE_BLOB.delete(row.r2_key);
    await c.env.DB.prepare("DELETE FROM messages WHERE id = ?1")
      .bind(row.id)
      .run();
  }

  return c.json({ ok: true });
});

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Internal server error." }, 500);
});

async function requireSession(c: any, next: () => Promise<void>) {
  if (!c.get("session")) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  await next();
}

async function listFriends(db: D1Database, userId: string): Promise<FriendSummary[]> {
  const result = await db.prepare(
    `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.avatar_url,
        (
          SELECT c.id
          FROM conversations c
          JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?1
          JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = u.id
          WHERE c.kind = 'direct'
          LIMIT 1
        ) AS conversation_id
      FROM friend_requests fr
      JOIN users u
        ON u.id = CASE
          WHEN fr.from_user_id = ?1 THEN fr.to_user_id
          ELSE fr.from_user_id
        END
      WHERE (fr.from_user_id = ?1 OR fr.to_user_id = ?1) AND fr.status = 'accepted'
      GROUP BY u.id
      ORDER BY u.display_name ASC
    `
  )
    .bind(userId)
    .all<{
      id: string;
      email: string;
      display_name: string;
      avatar_url: string | null;
      conversation_id: string | null;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    conversationId: row.conversation_id
  }));
}

async function listFriendRequests(db: D1Database, userId: string): Promise<FriendRequestSummary[]> {
  const result = await db.prepare(
    `
      SELECT
        fr.id,
        fr.from_user_id,
        fr.to_user_id,
        fr.status,
        fr.created_at,
        u.id AS counterparty_id,
        u.email AS counterparty_email,
        u.display_name AS counterparty_name,
        u.avatar_url AS counterparty_avatar
      FROM friend_requests fr
      JOIN users u
        ON u.id = CASE
          WHEN fr.from_user_id = ?1 THEN fr.to_user_id
          ELSE fr.from_user_id
        END
      WHERE (fr.from_user_id = ?1 OR fr.to_user_id = ?1)
      ORDER BY fr.created_at DESC
    `
  )
    .bind(userId)
    .all<{
      id: string;
      from_user_id: string;
      to_user_id: string;
      status: "pending" | "accepted" | "rejected";
      created_at: string;
      counterparty_id: string;
      counterparty_email: string;
      counterparty_name: string;
      counterparty_avatar: string | null;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    direction: row.from_user_id === userId ? "outgoing" : "incoming",
    counterparty: {
      id: row.counterparty_id,
      email: row.counterparty_email,
      displayName: row.counterparty_name,
      avatarUrl: row.counterparty_avatar
    },
    status: row.status,
    createdAt: row.created_at
  }));
}

async function listConversations(db: D1Database, userId: string): Promise<ConversationSummary[]> {
  const result = await db.prepare(
    `
      SELECT
        c.id,
        c.kind,
        c.expires_in_seconds,
        MAX(m.created_at) AS last_message_at,
        u.id AS counterpart_id,
        u.email AS counterpart_email,
        u.display_name AS counterpart_name,
        u.avatar_url AS counterpart_avatar
      FROM conversation_members self_member
      JOIN conversations c ON c.id = self_member.conversation_id
      JOIN conversation_members other_member
        ON other_member.conversation_id = c.id AND other_member.user_id <> ?1
      JOIN users u ON u.id = other_member.user_id
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE self_member.user_id = ?1
      GROUP BY c.id
      ORDER BY COALESCE(last_message_at, c.created_at) DESC
    `
  )
    .bind(userId)
    .all<{
      id: string;
      kind: "direct";
      expires_in_seconds: number;
      last_message_at: string | null;
      counterpart_id: string;
      counterpart_email: string;
      counterpart_name: string;
      counterpart_avatar: string | null;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    counterpart: {
      id: row.counterpart_id,
      email: row.counterpart_email,
      displayName: row.counterpart_name,
      avatarUrl: row.counterpart_avatar
    },
    expiresInSeconds: row.expires_in_seconds,
    lastMessageAt: row.last_message_at
  }));
}

async function loadConversationDetail(
  db: D1Database,
  bucket: R2Bucket,
  conversationId: string,
  userId: string
): Promise<ConversationDetail> {
  const conversation = (await listConversations(db, userId)).find((item) => item.id === conversationId);
  if (!conversation) {
    throw new Error("Conversation not found.");
  }

  const participantsResult = await db.prepare(
    `
      SELECT users.id, users.email, users.display_name, users.avatar_url
      FROM conversation_members
      JOIN users ON users.id = conversation_members.user_id
      WHERE conversation_members.conversation_id = ?1
      ORDER BY users.display_name ASC
    `
  )
    .bind(conversationId)
    .all<{
      id: string;
      email: string;
      display_name: string;
      avatar_url: string | null;
    }>();

  const devicesResult = await db.prepare(
    `
      SELECT devices.id AS device_id, devices.user_id, devices.label, devices.public_key
      FROM devices
      JOIN conversation_members ON conversation_members.user_id = devices.user_id
      WHERE conversation_members.conversation_id = ?1 AND devices.revoked_at IS NULL
      ORDER BY devices.last_seen_at DESC
    `
  )
    .bind(conversationId)
    .all<{
      device_id: string;
      user_id: string;
      label: string;
      public_key: string;
    }>();

  const messageRows = await db.prepare(
    `
      SELECT
        messages.id,
        messages.sender_user_id,
        users.display_name AS sender_display_name,
        users.avatar_url AS sender_avatar_url,
        messages.created_at,
        messages.expires_at,
        messages.burn_after_read,
        messages.r2_key
      FROM messages
      JOIN users ON users.id = messages.sender_user_id
      WHERE messages.conversation_id = ?1
      ORDER BY messages.created_at ASC
      LIMIT 100
    `
  )
    .bind(conversationId)
    .all<MessageIndexRow>();

  const messages = (
    await Promise.all(
      messageRows.results.map(async (row) => {
        const object = await bucket.get(row.r2_key);
        if (!object) {
          return null;
        }

        const envelope = (await object.json()) as CiphertextEnvelope;
        return {
          id: row.id,
          senderUserId: row.sender_user_id,
          senderDisplayName: row.sender_display_name,
          senderAvatarUrl: row.sender_avatar_url,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          burnAfterRead: Boolean(row.burn_after_read),
          envelope
        };
      })
    )
  ).filter((message): message is ConversationDetail["messages"][number] => message !== null);

  return {
    conversation,
    participants: participantsResult.results.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      avatarUrl: row.avatar_url
    })),
    participantDevices: devicesResult.results.map((row) => ({
      userId: row.user_id,
      deviceId: row.device_id,
      label: row.label,
      publicKey: row.public_key
    })),
    messages
  };
}

async function assertR2QuotaAvailable(
  db: D1Database,
  userId: string,
  messageBytes: number
): Promise<string | null> {
  const [activeUsage, senderDailyUsage] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(ciphertext_bytes), 0) AS total_bytes FROM messages")
      .first<{ total_bytes: number }>(),
    db.prepare(
      `
        SELECT COUNT(*) AS message_count
        FROM messages
        WHERE sender_user_id = ?1 AND created_at >= ?2
      `
    )
      .bind(userId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .first<{ message_count: number }>()
  ]);

  if ((activeUsage?.total_bytes ?? 0) + messageBytes > MAX_ACTIVE_R2_BYTES) {
    return "R2 active storage cap reached. Wait for burn timers to clear older messages.";
  }

  if ((senderDailyUsage?.message_count ?? 0) >= MAX_MESSAGES_PER_USER_PER_DAY) {
    return "Daily encrypted message cap reached for this account.";
  }

  try {
    await incrementUsageCounter(db, "r2_writes_day", 0, MAX_R2_WRITES_PER_DAY);
  } catch {
    return "Daily R2 write cap reached.";
  }

  return null;
}

async function incrementUsageCounter(
  db: D1Database,
  metric: string,
  incrementBy: number,
  maxValue: number
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${metric}:${today}`;
  const existing = await db.prepare(
    "SELECT value FROM usage_counters WHERE metric = ?1"
  )
    .bind(key)
    .first<{ value: number }>();
  const nextValue = (existing?.value ?? 0) + incrementBy;
  if (nextValue > maxValue) {
    throw new Error(`Usage cap exceeded for ${metric}`);
  }

  await db.prepare(
    `
      INSERT INTO usage_counters (metric, value, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(metric) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `
  )
    .bind(key, nextValue, new Date().toISOString())
    .run();
}

async function ensureDirectConversation(db: D1Database, userIds: [string, string]): Promise<string> {
  const existing = await db.prepare(
    `
      SELECT c.id
      FROM conversations c
      JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?1
      JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?2
      WHERE c.kind = 'direct'
      LIMIT 1
    `
  )
    .bind(userIds[0], userIds[1])
    .first<{ id: string }>();

  if (existing) {
    return existing.id;
  }

  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "INSERT INTO conversations (id, kind, expires_in_seconds, created_at) VALUES (?1, 'direct', ?2, ?3)"
    ).bind(conversationId, 24 * 60 * 60, now),
    db.prepare(
      "INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?1, ?2, ?4), (?1, ?3, ?4)"
    ).bind(conversationId, userIds[0], userIds[1], now),
    db.prepare(
      `
        UPDATE friend_requests
        SET status = 'accepted', responded_at = ?3
        WHERE (from_user_id = ?1 AND to_user_id = ?2) OR (from_user_id = ?2 AND to_user_id = ?1)
      `
    ).bind(userIds[0], userIds[1], now)
  ]);

  return conversationId;
}

async function findOrCreateUser(
  db: D1Database,
  provider: ProviderName,
  profile: ProviderProfile
): Promise<string> {
  const existingIdentity = await db.prepare(
    "SELECT user_id FROM auth_identities WHERE provider = ?1 AND provider_subject = ?2"
  )
    .bind(provider, profile.subject)
    .first<{ user_id: string }>();

  if (existingIdentity) {
    await db.prepare(
      "UPDATE users SET display_name = ?1, avatar_url = ?2, updated_at = ?3 WHERE id = ?4"
    )
      .bind(profile.displayName, profile.avatarUrl, new Date().toISOString(), existingIdentity.user_id)
      .run();
    return existingIdentity.user_id;
  }

  const existingUser = await db.prepare("SELECT id FROM users WHERE lower(email) = ?1")
    .bind(profile.email.toLowerCase())
    .first<{ id: string }>();

  const userId = existingUser?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();

  if (!existingUser) {
    await db.prepare(
      `
        INSERT INTO users (id, email, display_name, avatar_url, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      `
    )
      .bind(userId, profile.email, profile.displayName, profile.avatarUrl, now)
      .run();
  }

  await db.prepare(
    `
      INSERT INTO auth_identities (id, user_id, provider, provider_subject, email, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `
  )
    .bind(crypto.randomUUID(), userId, provider, profile.subject, profile.email, now)
    .run();

  return userId;
}

function getAuthorizationUrl(provider: ProviderName, env: Bindings): URL | null {
  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_REDIRECT_URI) {
      return null;
    }

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("prompt", "select_account");
    return url;
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_REDIRECT_URI) {
    return null;
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.GITHUB_REDIRECT_URI);
  url.searchParams.set("scope", "read:user user:email");
  return url;
}

async function exchangeCodeForProfile(
  provider: ProviderName,
  code: string,
  env: Bindings
): Promise<ProviderProfile | null> {
  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
      return null;
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    if (!tokenResponse.ok) {
      return null;
    }

    const tokens = (await tokenResponse.json()) as { access_token?: string };
    if (!tokens.access_token) {
      return null;
    }

    const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    if (!userInfoResponse.ok) {
      return null;
    }

    const profile = (await userInfoResponse.json()) as {
      sub: string;
      email: string;
      name: string;
      picture?: string;
    };

    return {
      subject: profile.sub,
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.picture ?? null
    };
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.GITHUB_REDIRECT_URI) {
    return null;
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      code,
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      redirect_uri: env.GITHUB_REDIRECT_URI
    })
  });

  if (!tokenResponse.ok) {
    return null;
  }

  const tokens = (await tokenResponse.json()) as { access_token?: string };
  if (!tokens.access_token) {
    return null;
  }

  const [userResponse, emailResponse] = await Promise.all([
    fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "simplechat"
      }
    }),
    fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "simplechat"
      }
    })
  ]);

  if (!userResponse.ok || !emailResponse.ok) {
    return null;
  }

  const user = (await userResponse.json()) as {
    id: number;
    login: string;
    name?: string;
    avatar_url?: string;
  };
  const emails = (await emailResponse.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;
  const primaryEmail = emails.find((item) => item.primary && item.verified) ?? emails[0];

  if (!primaryEmail?.email) {
    return null;
  }

  return {
    subject: String(user.id),
    email: primaryEmail.email,
    displayName: user.name || user.login,
    avatarUrl: user.avatar_url ?? null
  };
}

function safeParseState(value: string): OAuthStatePayload | null {
  try {
    const payload = JSON.parse(atob(value)) as OAuthStatePayload;
    if (Date.now() - payload.createdAt > 10 * 60 * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function validateEnvelope(envelope: CiphertextEnvelope): boolean {
  return (
    envelope.version === 1 &&
    Boolean(envelope.messageId) &&
    Boolean(envelope.conversationId) &&
    Boolean(envelope.senderDeviceId) &&
    Boolean(envelope.ephemeralPublicKey) &&
    Boolean(envelope.payloadIv) &&
    Boolean(envelope.ciphertext) &&
    Array.isArray(envelope.wrappedKeys) &&
    envelope.wrappedKeys.length > 0
  );
}

async function createSession(c: any, userId: string): Promise<void> {
  const sessionToken = randomToken();
  const sessionTokenHash = await sha256Hex(sessionToken + c.env.SESSION_SECRET);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const sessionId = crypto.randomUUID();

  await c.env.DB.prepare(
    `
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    `
  )
    .bind(sessionId, userId, sessionTokenHash, expiresAt, now.toISOString())
    .run();

  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<string> {
  const seed = concatBytes(Uint8Array.from(salt), new TextEncoder().encode(password));
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(seed)));

  for (let index = 1; index < iterations; index += 1) {
    digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(concatBytes(Uint8Array.from(salt), digest))
      )
    );
  }

  return toBase64Url(digest);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function normalizeEmail(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Uint8Array.from(atob(normalized + padding), (char) => char.charCodeAt(0));
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Bindings): Promise<void> => {
    const now = new Date().toISOString();
    const expiredMessages = await env.DB.prepare(
      "SELECT id, r2_key FROM messages WHERE expires_at <= ?1 LIMIT 500"
    )
      .bind(now)
      .all<{ id: string; r2_key: string }>();

    for (const row of expiredMessages.results) {
      await env.MESSAGE_BLOB.delete(row.r2_key);
    }

    if (expiredMessages.results.length > 0) {
      const placeholders = expiredMessages.results.map(() => "?").join(", ");
      await env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
        .bind(...expiredMessages.results.map((row) => row.id))
        .run();
    }

    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
      env.DB.prepare("DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at <= ?1").bind(now),
      env.DB.prepare("DELETE FROM usage_counters WHERE updated_at <= ?1").bind(
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      )
    ]);
  }
};
