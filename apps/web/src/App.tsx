import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Typography
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import LockIcon from "@mui/icons-material/Lock";
import LogoutIcon from "@mui/icons-material/Logout";
import ShieldIcon from "@mui/icons-material/Shield";
import { TTL_PRESETS, type ConversationSummary, type OAuthProviderConfig } from "@simplechat/protocol";
import { api } from "./lib/api";
import {
  decryptMessage,
  encryptMarkdownMessage,
  ensureDeviceIdentity,
  type DecryptedMessage,
  type DeviceIdentity
} from "./lib/crypto";
import { MarkdownMessage } from "./components/MarkdownMessage";

type SessionState =
  | { loading: true }
  | { loading: false; user: null }
  | {
      loading: false;
      user: {
        id: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
      };
    };

export default function App() {
  const [providers, setProviders] = useState<OAuthProviderConfig[]>([]);
  const [session, setSession] = useState<SessionState>({ loading: true });
  const [device, setDevice] = useState<DeviceIdentity | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationDetail, setConversationDetail] = useState<any | null>(null);
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [friendEmail, setFriendEmail] = useState("");
  const [selectedTtl, setSelectedTtl] = useState(TTL_PRESETS[1].value);
  const [burnAfterRead, setBurnAfterRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const readMarksRef = useRef(new Set<string>());
  const currentUser = !session.loading ? session.user : null;

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );
  const oauthProviders = providers.filter((provider) => provider.id !== "local" && provider.enabled);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!session.loading && currentUser) {
      void hydrateAuthenticatedState();
    }
  }, [currentUser, session.loading]);

  useEffect(() => {
    if (!activeConversationId || !currentUser) {
      return;
    }

    void loadConversation(activeConversationId);
    const timer = window.setInterval(() => {
      void loadConversation(activeConversationId);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [activeConversationId, currentUser, device?.deviceId, session.loading]);

  async function bootstrap() {
    try {
      const [providersResponse, sessionResponse] = await Promise.all([
        api.getProviders(),
        api.getSession()
      ]);
      setProviders(providersResponse.providers);
      setSession(
        sessionResponse.authenticated && sessionResponse.user
          ? { loading: false, user: sessionResponse.user }
          : { loading: false, user: null }
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to initialize app.");
      setSession({ loading: false, user: null });
    }
  }

  async function hydrateAuthenticatedState() {
    try {
      const identity = await ensureDeviceIdentity();
      await api.registerDevice({
        deviceId: identity.deviceId,
        label: identity.label,
        publicKey: identity.publicKey
      });
      setDevice(identity);
      const [friendsResponse, requestsResponse, conversationsResponse] = await Promise.all([
        api.getFriends(),
        api.getFriendRequests(),
        api.getConversations()
      ]);
      setFriends(friendsResponse.friends);
      setRequests(requestsResponse.requests);
      setConversations(conversationsResponse.conversations);
      setActiveConversationId((current) => current ?? conversationsResponse.conversations[0]?.id ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to load encrypted workspace.");
    }
  }

  async function loadConversation(conversationId: string) {
    if (!device) {
      return;
    }

    try {
      const detail = await api.getConversation(conversationId);
      const decrypted = await Promise.all(
        detail.messages.map((message: any) => decryptMessage(device, message))
      );
      const visible = decrypted.filter(Boolean) as DecryptedMessage[];
      setConversationDetail(detail);
      setMessages(visible);

      for (const message of visible) {
        if (
          message.burnAfterRead &&
          message.senderUserId !== currentUser?.id &&
          !readMarksRef.current.has(message.id)
        ) {
          readMarksRef.current.add(message.id);
          void api.markMessageRead(conversationId, message.id);
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to load conversation.");
    }
  }

  async function handleSendMessage() {
    if (!composer.trim() || !activeConversationId || !device || !conversationDetail) {
      return;
    }

    setBusy(true);
    try {
      const recipients = conversationDetail.participantDevices.map((item: any) => ({
        deviceId: item.deviceId,
        publicKey: item.publicKey
      }));
      const envelope = await encryptMarkdownMessage({
        conversationId: activeConversationId,
        senderDeviceId: device.deviceId,
        markdown: composer.trim(),
        burnAfterRead,
        ttlSeconds: selectedTtl,
        recipients
      });
      await api.sendMessage(activeConversationId, envelope);
      setComposer("");
      await loadConversation(activeConversationId);
      const conversationsResponse = await api.getConversations();
      setConversations(conversationsResponse.conversations);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddFriend() {
    if (!friendEmail.trim()) {
      return;
    }

    setBusy(true);
    try {
      await api.createFriendRequest(friendEmail.trim());
      setFriendEmail("");
      const requestsResponse = await api.getFriendRequests();
      setRequests(requestsResponse.requests);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to send friend request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptRequest(requestId: string) {
    setBusy(true);
    try {
      await api.acceptFriendRequest(requestId);
      await hydrateAuthenticatedState();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to accept request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await api.logout();
    window.location.reload();
  }

  async function handleLocalAuth() {
    setBusy(true);
    try {
      if (authMode === "register") {
        await api.register({
          email: authEmail,
          password: authPassword,
          displayName: authDisplayName
        });
      } else {
        await api.login({
          email: authEmail,
          password: authPassword
        });
      }

      setAuthPassword("");
      await bootstrap();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  if (session.loading) {
    return (
      <Box className="centered">
        <CircularProgress />
      </Box>
    );
  }

  if (!session.user) {
    return (
      <Box className="login-shell">
        <Paper className="login-card" elevation={0}>
          <Stack spacing={3}>
            {notice && (
              <Alert severity="error" onClose={() => setNotice(null)}>
                {notice}
              </Alert>
            )}
            <Stack spacing={1}>
              <Chip icon={<LockIcon />} label="E2EE by default" sx={{ alignSelf: "flex-start" }} />
              <Typography variant="h4">SimpleChat</Typography>
              <Typography color="text.secondary">
                Cloudflare-backed encrypted messaging with local-only decryption, timed burn,
                Markdown messages, and device-scoped identity keys.
              </Typography>
            </Stack>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1}>
                <Chip
                  label="Login"
                  color={authMode === "login" ? "primary" : "default"}
                  clickable
                  onClick={() => setAuthMode("login")}
                />
                <Chip
                  label="Register"
                  color={authMode === "register" ? "primary" : "default"}
                  clickable
                  onClick={() => setAuthMode("register")}
                />
              </Stack>
              {authMode === "register" && (
                <TextField
                  label="Display name"
                  value={authDisplayName}
                  onChange={(event) => setAuthDisplayName(event.target.value)}
                />
              )}
              <TextField
                label="Email"
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
              />
              <TextField
                label="Password"
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                helperText="Minimum 10 characters. Password hash is stored in D1."
              />
              <Button variant="contained" size="large" onClick={handleLocalAuth} disabled={busy}>
                {authMode === "register" ? "Create secure account" : "Sign in"}
              </Button>
              <Divider>Optional OAuth later</Divider>
              {oauthProviders.map((provider) => (
                <Button
                  key={provider.id}
                  variant="contained"
                  size="large"
                  href={`${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787"}/auth/oauth/${provider.id}/start`}
                >
                  Continue with {provider.name}
                </Button>
              ))}
              {oauthProviders.length === 0 && (
                <Alert severity="warning">
                  OAuth providers are not configured yet. Local email/password auth is enabled.
                </Alert>
              )}
              <Alert severity="info">
                R2 free-tier guardrails are active: 8 KB max encrypted envelope, 250 messages per
                user per day, 128 MB active ciphertext cap.
              </Alert>
            </Stack>
          </Stack>
        </Paper>
      </Box>
    );
  }

  return (
    <Box className="app-shell">
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar className="topbar">
          <Stack direction="row" spacing={1.5} alignItems="center">
            <IconButton onClick={() => setSidebarOpen(true)} className="mobile-only">
              <ShieldIcon />
            </IconButton>
            <Typography variant="h5">SimpleChat Secure</Typography>
            <Chip icon={<ShieldIcon />} label="Server stores ciphertext only" />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip label={device?.label ?? "Provisioning key"} color="primary" variant="outlined" />
            <Button startIcon={<LogoutIcon />} onClick={handleLogout}>
              Sign out
            </Button>
          </Stack>
        </Toolbar>
      </AppBar>

      {notice && (
        <Alert severity="info" onClose={() => setNotice(null)} sx={{ mx: 3 }}>
          {notice}
        </Alert>
      )}

      <Box className="workspace">
        <Drawer
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          className="mobile-only"
          PaperProps={{ className: "drawer-paper" }}
        >
          <SidebarContent
            conversations={conversations}
            activeConversationId={activeConversationId}
            onSelectConversation={(id) => {
              setActiveConversationId(id);
              setSidebarOpen(false);
            }}
            friends={friends}
            requests={requests}
            friendEmail={friendEmail}
            setFriendEmail={setFriendEmail}
            onAddFriend={handleAddFriend}
            onAcceptRequest={handleAcceptRequest}
          />
        </Drawer>

        <Paper className="sidebar desktop-only" elevation={0}>
          <SidebarContent
            conversations={conversations}
            activeConversationId={activeConversationId}
            onSelectConversation={setActiveConversationId}
            friends={friends}
            requests={requests}
            friendEmail={friendEmail}
            setFriendEmail={setFriendEmail}
            onAddFriend={handleAddFriend}
            onAcceptRequest={handleAcceptRequest}
          />
        </Paper>

        <Paper className="chat-panel" elevation={0}>
          <Stack className="chat-header" direction="row" alignItems="center" spacing={2}>
            <Avatar src={activeConversation?.counterpart?.avatarUrl ?? undefined}>
              {activeConversation?.counterpart?.displayName?.[0] ?? "?"}
            </Avatar>
            <Box>
              <Typography variant="h6">
                {activeConversation?.counterpart?.displayName ?? "Select a conversation"}
              </Typography>
              <Typography color="text.secondary">
                Burn window: {Math.round((activeConversation?.expiresInSeconds ?? selectedTtl) / 60)}m
              </Typography>
            </Box>
          </Stack>
          <Divider />

          <Stack className="message-list" spacing={2}>
            {messages.map((message) => {
              const outgoing = message.senderUserId === currentUser?.id;
              return (
                <Stack
                  key={message.id}
                  direction="row"
                  justifyContent={outgoing ? "flex-end" : "flex-start"}
                >
                  <Stack spacing={0.75} alignItems={outgoing ? "flex-end" : "flex-start"}>
                    <Typography variant="caption" color="text.secondary">
                      {message.senderDisplayName} · {new Date(message.createdAt).toLocaleString()}
                    </Typography>
                    <MarkdownMessage markdown={message.markdown} outgoing={outgoing} />
                    {message.burnAfterRead && (
                      <Chip size="small" color="warning" label="Burn after read" />
                    )}
                  </Stack>
                </Stack>
              );
            })}
            {!messages.length && (
              <Box className="empty-state">
                <Typography variant="h6">No messages yet</Typography>
                <Typography color="text.secondary">
                  Start the conversation with a Markdown message. The server will store only the
                  encrypted envelope.
                </Typography>
              </Box>
            )}
          </Stack>

          <Divider />

          <Stack className="composer-panel" spacing={1.5}>
            <TextField
              minRows={6}
              multiline
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Write encrypted Markdown..."
            />
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              {TTL_PRESETS.map((preset) => (
                <Chip
                  key={preset.value}
                  label={preset.label}
                  clickable
                  color={selectedTtl === preset.value ? "primary" : "default"}
                  onClick={() => setSelectedTtl(preset.value)}
                />
              ))}
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="body2">Burn after read</Typography>
                <Switch checked={burnAfterRead} onChange={(event) => setBurnAfterRead(event.target.checked)} />
              </Stack>
            </Stack>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography color="text.secondary" variant="body2">
                Padding and envelope encryption happen locally before upload.
              </Typography>
              <Button
                variant="contained"
                endIcon={busy ? <CircularProgress size={16} color="inherit" /> : <AddIcon />}
                disabled={busy || !activeConversationId || !composer.trim()}
                onClick={handleSendMessage}
              >
                Send secure message
              </Button>
            </Stack>
          </Stack>
        </Paper>

        <Paper className="security-panel desktop-only" elevation={0}>
          <Stack spacing={2.5}>
            <Box>
              <Typography variant="h6">Security posture</Typography>
              <Typography color="text.secondary">
                The Worker stores metadata in D1, ciphertext blobs in R2, and deletes expired
                content on cron. Decryption stays in your browser.
              </Typography>
            </Box>
            <Stack spacing={1}>
              <Chip icon={<LockIcon />} label="X25519 + AES-GCM envelope" />
              <Chip icon={<ShieldIcon />} label="Opaque R2 ciphertext storage" />
              <Chip label="Cross-client protocol ready" />
            </Stack>
            <Divider />
            <Box>
              <Typography variant="subtitle1">Current account</Typography>
              <Typography>{currentUser?.displayName}</Typography>
              <Typography color="text.secondary">{currentUser?.email}</Typography>
            </Box>
            <Box>
              <Typography variant="subtitle1">Device key</Typography>
              <Typography color="text.secondary">
                {device?.publicKey.slice(0, 24)}...
              </Typography>
            </Box>
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}

function SidebarContent(props: {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  friends: any[];
  requests: any[];
  friendEmail: string;
  setFriendEmail: (value: string) => void;
  onAddFriend: () => void;
  onAcceptRequest: (requestId: string) => void;
}) {
  return (
    <Stack className="sidebar-content" spacing={2.5}>
      <Box>
        <Typography variant="h6">Conversations</Typography>
        <List disablePadding>
          {props.conversations.map((conversation) => (
            <ListItemButton
              key={conversation.id}
              selected={props.activeConversationId === conversation.id}
              onClick={() => props.onSelectConversation(conversation.id)}
            >
              <ListItemText
                primary={conversation.counterpart?.displayName ?? "Direct conversation"}
                secondary={conversation.counterpart?.email ?? "Encrypted channel"}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>
      <Divider />
      <Stack spacing={1.5}>
        <Typography variant="h6">Add friend</Typography>
        <TextField
          size="small"
          value={props.friendEmail}
          onChange={(event) => props.setFriendEmail(event.target.value)}
          placeholder="friend@example.com"
        />
        <Button variant="contained" onClick={props.onAddFriend}>
          Send request
        </Button>
      </Stack>
      <Divider />
      <Box>
        <Typography variant="h6">Incoming requests</Typography>
        <Stack spacing={1.5} mt={1.5}>
          {props.requests
            .filter((request: any) => request.direction === "incoming" && request.status === "pending")
            .map((request: any) => (
              <Paper key={request.id} variant="outlined" sx={{ p: 1.5 }}>
                <Typography>{request.counterparty.displayName}</Typography>
                <Typography color="text.secondary" variant="body2">
                  {request.counterparty.email}
                </Typography>
                <Button sx={{ mt: 1 }} size="small" onClick={() => props.onAcceptRequest(request.id)}>
                  Accept
                </Button>
              </Paper>
            ))}
          {!props.requests.some((request: any) => request.direction === "incoming" && request.status === "pending") && (
            <Typography color="text.secondary">No pending requests.</Typography>
          )}
        </Stack>
      </Box>
      <Divider />
      <Box>
        <Typography variant="h6">Friends</Typography>
        <Stack spacing={1} mt={1.5}>
          {props.friends.map((friend: any) => (
            <Paper key={friend.id} variant="outlined" sx={{ p: 1.5 }}>
              <Typography>{friend.displayName}</Typography>
              <Typography color="text.secondary" variant="body2">
                {friend.email}
              </Typography>
            </Paper>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}
