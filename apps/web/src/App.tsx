import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
  useMediaQuery
} from "@mui/material";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import ForumRoundedIcon from "@mui/icons-material/ForumRounded";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import MailOutlineRoundedIcon from "@mui/icons-material/MailOutlineRounded";
import PersonAddRoundedIcon from "@mui/icons-material/PersonAddRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import ShieldRoundedIcon from "@mui/icons-material/ShieldRounded";
import TimerOutlinedIcon from "@mui/icons-material/TimerOutlined";
import WhatshotRoundedIcon from "@mui/icons-material/WhatshotRounded";
import {
  TTL_PRESETS,
  type CiphertextEnvelope,
  type ConversationDetail,
  type ConversationSummary,
  type OAuthProviderConfig
} from "@simplechat/protocol";
import { MarkdownMessage } from "./components/MarkdownMessage";
import { api } from "./lib/api";
import {
  decryptMessage,
  encryptMarkdownMessage,
  ensureDeviceIdentity,
  type DecryptedMessage,
  type DeviceIdentity
} from "./lib/crypto";

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

type User = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
};

type ConversationMeta = {
  preview: string;
  unreadCount: number;
  lastMessageAt: string | null;
};

type MessageClientStatus = "sending" | "sent-local" | "failed";

type ChatMessage = DecryptedMessage & {
  clientStatus?: MessageClientStatus;
};

type ConversationCacheEntry = {
  detail: ConversationDetail;
  messages: ChatMessage[];
};

type SidebarSection = "chats" | "people" | "requests";

const SEEN_STORAGE_KEY = "simplechat_seen_map";
const INITIAL_VISIBLE_MESSAGES = 80;
const MESSAGE_PAGE_SIZE = 80;
const AUTO_SCROLL_THRESHOLD = 96;

export default function App() {
  const isMobile = useMediaQuery("(max-width:900px)");
  const [providers, setProviders] = useState<OAuthProviderConfig[]>([]);
  const [session, setSession] = useState<SessionState>({ loading: true });
  const [device, setDevice] = useState<DeviceIdentity | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationCache, setConversationCache] = useState<Record<string, ConversationCacheEntry>>({});
  const [composer, setComposer] = useState("");
  const [friendEmail, setFriendEmail] = useState("");
  const [selectedTtl, setSelectedTtl] = useState(TTL_PRESETS[1].value);
  const [burnAfterRead, setBurnAfterRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [conversationMeta, setConversationMeta] = useState<Record<string, ConversationMeta>>({});
  const [seenMap, setSeenMap] = useState<Record<string, string>>(() => loadSeenMap());
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>("chats");
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [showNewMessageNotice, setShowNewMessageNotice] = useState(false);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const readMarksRef = useRef(new Set<string>());
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollOffsetRef = useRef<number | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const syncRequestRef = useRef(0);
  const previousMessageStateRef = useRef<{ conversationId: string | null; count: number }>({
    conversationId: null,
    count: 0
  });
  const currentUser = !session.loading ? session.user : null;

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );
  const oauthProviders = providers.filter((provider) => provider.id !== "local" && provider.enabled);
  const incomingRequests = useMemo(
    () =>
      requests.filter(
        (request: any) => request.direction === "incoming" && request.status === "pending"
      ),
    [requests]
  );
  const displayedMessages = useMemo(
    () => messages.slice(-visibleMessageCount),
    [messages, visibleMessageCount]
  );
  const hasOlderMessages = displayedMessages.length < messages.length;
  const selectedTtlPreset = TTL_PRESETS.find((preset) => preset.value === selectedTtl) ?? TTL_PRESETS[0];
  const isConversationLoading =
    Boolean(activeConversationId) && loadingConversationId === activeConversationId;

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!session.loading && currentUser) {
      void hydrateAuthenticatedState();
    }
  }, [currentUser, isMobile, session.loading]);

  useEffect(() => {
    if (!currentUser || !device) {
      return;
    }

    void syncWorkspace(activeConversationId);
    const timer = window.setInterval(() => {
      void syncWorkspace(activeConversationId);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [activeConversationId, currentUser, device?.deviceId]);

  useEffect(() => {
    if (isMobile) {
      return;
    }

    if (!activeConversationId && conversations.length > 0) {
      setActiveConversationId(conversations[0].id);
    }
  }, [activeConversationId, conversations, isMobile]);

  useEffect(() => {
    if (!activeConversationId) {
      setConversationDetail(null);
      setMessages([]);
      setShowNewMessageNotice(false);
      return;
    }

    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setShowNewMessageNotice(false);
    shouldStickToBottomRef.current = true;
  }, [activeConversationId]);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    const cachedConversation = conversationCache[activeConversationId];
    if (cachedConversation) {
      setConversationDetail(cachedConversation.detail);
      setMessages(cachedConversation.messages);
    } else {
      setConversationDetail(null);
      setMessages([]);
    }
  }, [activeConversationId, conversationCache]);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    if (conversations.some((conversation) => conversation.id === activeConversationId)) {
      return;
    }

    setActiveConversationId(isMobile ? null : conversations[0]?.id ?? null);
  }, [activeConversationId, conversations, isMobile]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list || pendingScrollOffsetRef.current === null) {
      return;
    }

    const previousOffset = pendingScrollOffsetRef.current;
    pendingScrollOffsetRef.current = null;

    window.requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight - previousOffset;
    });
  }, [displayedMessages.length]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) {
      previousMessageStateRef.current = {
        conversationId: activeConversationId,
        count: messages.length
      };
      return;
    }

    const previousState = previousMessageStateRef.current;
    const conversationChanged = previousState.conversationId !== activeConversationId;
    const countIncreased = messages.length > previousState.count;
    const latestMessage = messages.at(-1);
    const latestOutgoing = latestMessage?.senderUserId === currentUser?.id;

    if (conversationChanged) {
      window.requestAnimationFrame(() => {
        list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
      });
      setShowNewMessageNotice(false);
    } else if (countIncreased) {
      if (shouldStickToBottomRef.current || latestOutgoing) {
        window.requestAnimationFrame(() => {
          list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
        });
        setShowNewMessageNotice(false);
      } else {
        setShowNewMessageNotice(true);
      }
    }

    previousMessageStateRef.current = {
      conversationId: activeConversationId,
      count: messages.length
    };
  }, [activeConversationId, currentUser?.id, messages]);

  function sortMessages(items: ChatMessage[]): ChatMessage[] {
    return [...items].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  }

  function mergeRemoteMessages(
    remoteMessages: DecryptedMessage[],
    existingMessages: ChatMessage[]
  ): ChatMessage[] {
    const remoteIds = new Set(remoteMessages.map((message) => message.id));
    const localMessages = existingMessages.filter(
      (message) => message.clientStatus && !remoteIds.has(message.id)
    );

    return sortMessages([
      ...remoteMessages.map((message) => ({ ...message, clientStatus: undefined })),
      ...localMessages
    ]);
  }

  function setConversationState(
    conversationId: string,
    detail: ConversationDetail,
    nextMessages: ChatMessage[]
  ) {
    const sortedMessages = sortMessages(nextMessages);

    setConversationCache((previous) => ({
      ...previous,
      [conversationId]: {
        detail,
        messages: sortedMessages
      }
    }));

    if (activeConversationId === conversationId) {
      setConversationDetail(detail);
      setMessages(sortedMessages);
    }
  }

  function patchConversationMessages(
    conversationId: string,
    updater: (items: ChatMessage[]) => ChatMessage[]
  ) {
    setConversationCache((previous) => {
      const cachedConversation = previous[conversationId];
      if (!cachedConversation) {
        return previous;
      }

      const nextMessages = sortMessages(updater(cachedConversation.messages));
      if (activeConversationId === conversationId) {
        setMessages(nextMessages);
      }

      return {
        ...previous,
        [conversationId]: {
          ...cachedConversation,
          messages: nextMessages
        }
      };
    });
  }

  function buildOptimisticEnvelope(input: {
    messageId: string;
    conversationId: string;
    senderDeviceId: string;
    createdAt: string;
    expiresAt: string;
    burnAfterRead: boolean;
  }): CiphertextEnvelope {
    return {
      version: 1,
      messageId: input.messageId,
      conversationId: input.conversationId,
      senderDeviceId: input.senderDeviceId,
      ephemeralPublicKey: "",
      payloadIv: "",
      ciphertext: "",
      wrappedKeys: [],
      paddingBucket: 0,
      burnAfterRead: input.burnAfterRead,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt
    };
  }

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
      const nextActiveConversationId =
        activeConversationId &&
        conversationsResponse.conversations.some((conversation) => conversation.id === activeConversationId)
          ? activeConversationId
          : isMobile
            ? null
            : conversationsResponse.conversations[0]?.id ?? null;
      setActiveConversationId(nextActiveConversationId);
      await syncConversationMeta(
        conversationsResponse.conversations,
        identity,
        currentUser?.id ?? null,
        nextActiveConversationId,
        ++syncRequestRef.current
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to load encrypted workspace.");
    }
  }

  async function syncWorkspace(targetConversationId: string | null) {
    if (!device) {
      return;
    }

    const requestId = ++syncRequestRef.current;
    const shouldShowLoader =
      Boolean(targetConversationId) && !conversationCache[targetConversationId ?? ""];

    if (shouldShowLoader && targetConversationId) {
      setLoadingConversationId(targetConversationId);
    }

    try {
      const [friendsResponse, requestsResponse, conversationsResponse] = await Promise.all([
        api.getFriends(),
        api.getFriendRequests(),
        api.getConversations()
      ]);

      if (requestId !== syncRequestRef.current) {
        return;
      }

      setFriends(friendsResponse.friends);
      setRequests(requestsResponse.requests);
      setConversations(conversationsResponse.conversations);
      await syncConversationMeta(
        conversationsResponse.conversations,
        device,
        currentUser?.id ?? null,
        targetConversationId,
        requestId
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to sync workspace.");
    } finally {
      if (shouldShowLoader && targetConversationId && requestId === syncRequestRef.current) {
        setLoadingConversationId((current) =>
          current === targetConversationId ? null : current
        );
      }
    }
  }

  async function syncConversationMeta(
    items: ConversationSummary[],
    identity: DeviceIdentity,
    userId: string | null,
    targetConversationId: string | null,
    requestId: number
  ) {
    const nextMeta: Record<string, ConversationMeta> = {};
    const targetConversation = targetConversationId
      ? items.find((conversation) => conversation.id === targetConversationId) ?? null
      : null;

    if (targetConversation) {
      const detail = await api.getConversation(targetConversation.id);
      const decrypted = await Promise.all(
        detail.messages.map((message: any) => decryptMessage(identity, message))
      );

      if (requestId !== syncRequestRef.current) {
        return;
      }

      const remoteMessages = decrypted.filter(Boolean) as DecryptedMessage[];
      const existingMessages =
        conversationCache[targetConversation.id]?.messages ??
        (activeConversationId === targetConversation.id ? messages : []);
      const visible = mergeRemoteMessages(remoteMessages, existingMessages);
      const lastMessage = visible.at(-1) ?? null;
      const lastSeenAt = seenMap[targetConversation.id];
      const unreadCount = visible.filter(
        (message) =>
          message.senderUserId !== userId &&
          (!lastSeenAt || new Date(message.createdAt).getTime() > new Date(lastSeenAt).getTime())
      ).length;

      nextMeta[targetConversation.id] = {
        preview: lastMessage ? toPreview(lastMessage.markdown) : "",
        unreadCount: 0,
        lastMessageAt: lastMessage?.createdAt ?? null
      };

      setConversationState(targetConversation.id, detail, visible);
      markConversationSeen(targetConversation.id, visible);

      for (const message of visible) {
        if (
          message.burnAfterRead &&
          message.senderUserId !== userId &&
          !readMarksRef.current.has(message.id)
        ) {
          readMarksRef.current.add(message.id);
          void api.markMessageRead(targetConversation.id, message.id);
        }
      }

      setLoadingConversationId((current) =>
        current === targetConversation.id ? null : current
      );
    }

    const remainingConversations = items.filter(
      (conversation) => conversation.id !== targetConversationId
    );
    const remainingResults = await Promise.all(
      remainingConversations.map(async (conversation) => {
        const detail = await api.getConversation(conversation.id);
        const decrypted = await Promise.all(
          detail.messages.map((message: any) => decryptMessage(identity, message))
        );
        const remoteMessages = decrypted.filter(Boolean) as DecryptedMessage[];
        const visible = mergeRemoteMessages(
          remoteMessages,
          conversationCache[conversation.id]?.messages ?? []
        );
        const lastMessage = visible.at(-1) ?? null;
        const lastSeenAt = seenMap[conversation.id];
        const unreadCount = visible.filter(
          (message) =>
            message.senderUserId !== userId &&
            (!lastSeenAt || new Date(message.createdAt).getTime() > new Date(lastSeenAt).getTime())
        ).length;

        return {
          conversationId: conversation.id,
          detail,
          visible,
          meta: {
            preview: lastMessage ? toPreview(lastMessage.markdown) : "",
            unreadCount,
            lastMessageAt: lastMessage?.createdAt ?? null
          }
        };
      })
    );

    if (requestId !== syncRequestRef.current) {
      return;
    }

    for (const result of remainingResults) {
      nextMeta[result.conversationId] = result.meta;
      setConversationState(result.conversationId, result.detail, result.visible);
    }

    setConversationMeta(nextMeta);
  }

  async function handleSendMessage() {
    if (!composer.trim() || !activeConversationId || !device || !conversationDetail) {
      return;
    }

    const conversationId = activeConversationId;
    const markdown = composer.trim();
    const messageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + selectedTtl * 1000).toISOString();
    const optimisticMessage: ChatMessage = {
      id: messageId,
      senderUserId: currentUser?.id ?? "",
      senderDisplayName: currentUser?.displayName ?? "You",
      senderAvatarUrl: currentUser?.avatarUrl ?? null,
      createdAt,
      expiresAt,
      burnAfterRead,
      envelope: buildOptimisticEnvelope({
        messageId,
        conversationId,
        senderDeviceId: device.deviceId,
        createdAt,
        expiresAt,
        burnAfterRead
      }),
      markdown,
      clientStatus: "sending"
    };

    setComposer("");
    shouldStickToBottomRef.current = true;
    setIsSendingMessage(true);

    const currentDetail =
      conversationCache[conversationId]?.detail ?? conversationDetail;
    if (currentDetail) {
      const existingMessages =
        conversationCache[conversationId]?.messages ??
        (activeConversationId === conversationId ? messages : []);
      const nextMessages = sortMessages([
        ...existingMessages.filter((item) => item.id !== optimisticMessage.id),
        optimisticMessage
      ]);
      setConversationState(conversationId, currentDetail, nextMessages);
      markConversationSeen(conversationId, nextMessages);
    }

    setConversationMeta((previous) => ({
      ...previous,
      [conversationId]: {
        preview: toPreview(markdown),
        unreadCount: 0,
        lastMessageAt: createdAt
      }
    }));

    try {
      const recipients = conversationDetail.participantDevices.map((item: any) => ({
        deviceId: item.deviceId,
        publicKey: item.publicKey
      }));
      const envelope = await encryptMarkdownMessage({
        conversationId,
        senderDeviceId: device.deviceId,
        markdown,
        burnAfterRead,
        ttlSeconds: selectedTtl,
        recipients,
        messageId,
        createdAt
      });
      await api.sendMessage(conversationId, envelope);
      patchConversationMessages(conversationId, (previous) =>
        previous.map((message) =>
          message.id === messageId
            ? {
                ...message,
                envelope,
                expiresAt: envelope.expiresAt,
                clientStatus: "sent-local"
              }
            : message
        )
      );
      void syncWorkspace(conversationId);
    } catch (error) {
      patchConversationMessages(conversationId, (previous) =>
        previous.map((message) =>
          message.id === messageId ? { ...message, clientStatus: "failed" } : message
        )
      );
      setNotice(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setIsSendingMessage(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!isSendingMessage) {
      void handleSendMessage();
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
      setSidebarSection("requests");
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
    window.localStorage.removeItem(SEEN_STORAGE_KEY);
    window.location.reload();
  }

  function handleSelectConversation(id: string) {
    if (id === activeConversationId) {
      setSidebarSection("chats");
      return;
    }

    setActiveConversationId(id);
    setShowNewMessageNotice(false);
    setSidebarSection("chats");
  }

  function handleBackToList() {
    setActiveConversationId(null);
    setSidebarSection("chats");
  }

  function handleMessageListScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const nearBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight <= AUTO_SCROLL_THRESHOLD;

    shouldStickToBottomRef.current = nearBottom;

    if (nearBottom) {
      setShowNewMessageNotice(false);
    }
  }

  function handleLoadOlderMessages() {
    const list = messageListRef.current;
    if (list) {
      pendingScrollOffsetRef.current = list.scrollHeight - list.scrollTop;
    }

    setVisibleMessageCount((previous) => Math.min(previous + MESSAGE_PAGE_SIZE, messages.length));
  }

  function scrollToLatest() {
    const list = messageListRef.current;
    if (!list) {
      return;
    }

    shouldStickToBottomRef.current = true;
    setShowNewMessageNotice(false);
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }

  function markConversationSeen(conversationId: string, visible: ChatMessage[]) {
    if (!visible.length) {
      return;
    }

    setSeenMap((previous) => {
      const nextSeenMap = {
        ...previous,
        [conversationId]: visible[visible.length - 1].createdAt
      };
      saveSeenMap(nextSeenMap);
      return nextSeenMap;
    });
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
          <Stack spacing={2.5}>
            {notice && (
              <Alert severity="error" onClose={() => setNotice(null)}>
                {notice}
              </Alert>
            )}
            <Stack spacing={0.75}>
              <Typography variant="overline" color="primary.main">
                Encrypted direct messaging
              </Typography>
              <Typography variant="h4">SimpleChat</Typography>
              <Typography color="text.secondary">
                一个更像桌面聊天应用的安全会话空间，而不是普通网页表单。
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
                helperText={authMode === "register" ? "Minimum 10 characters" : undefined}
              />
              <Button variant="contained" size="large" onClick={handleLocalAuth} disabled={busy}>
                {authMode === "register" ? "Create secure account" : "Sign in"}
              </Button>
              {oauthProviders.length > 0 && (
                <>
                  <Divider />
                  {oauthProviders.map((provider) => (
                    <Button
                      key={provider.id}
                      variant="outlined"
                      size="large"
                      href={`${import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787"}/auth/oauth/${provider.id}/start`}
                    >
                      Continue with {provider.name}
                    </Button>
                  ))}
                </>
              )}
            </Stack>
          </Stack>
        </Paper>
      </Box>
    );
  }

  return (
    <Box className="app-shell">
      {notice && (
        <Alert severity="info" onClose={() => setNotice(null)} className="notice-banner">
          {notice}
        </Alert>
      )}

      <Box className={`workspace ${isMobile ? "workspace-mobile" : ""}`}>
        {(!isMobile || !activeConversationId) && (
          <Paper className="sidebar-panel" elevation={0}>
            <SidebarContent
              currentUser={currentUser}
              conversations={conversations}
              conversationMeta={conversationMeta}
              activeConversationId={activeConversationId}
              onSelectConversation={handleSelectConversation}
              friends={friends}
              requests={incomingRequests}
              friendEmail={friendEmail}
              setFriendEmail={setFriendEmail}
              onAddFriend={handleAddFriend}
              onAcceptRequest={handleAcceptRequest}
              onLogout={handleLogout}
              sidebarSection={sidebarSection}
              setSidebarSection={setSidebarSection}
            />
          </Paper>
        )}

        {(!isMobile || activeConversationId) && (
          <Paper className="chat-panel" elevation={0}>
            <Stack className="chat-header" direction="row" alignItems="center" spacing={2}>
              {isMobile && (
                <IconButton onClick={handleBackToList} edge="start" aria-label="Back to chats">
                  <ArrowBackRoundedIcon />
                </IconButton>
              )}
              <Avatar src={activeConversation?.counterpart?.avatarUrl ?? undefined}>
                {getInitial(activeConversation?.counterpart?.displayName)}
              </Avatar>
              <Box className="chat-header-copy">
                <Typography variant="h6">
                  {activeConversation?.counterpart?.displayName ?? "Select a conversation"}
                </Typography>
                <Typography color="text.secondary">
                  {activeConversation?.counterpart?.email ?? "Pick a secure thread to start talking."}
                </Typography>
              </Box>
              {!isMobile && (
                <Chip
                  icon={<ShieldRoundedIcon />}
                  label="End-to-end encrypted"
                  color="primary"
                  variant="outlined"
                  className="chat-status-chip"
                />
              )}
            </Stack>

            <Box
              ref={messageListRef}
              className={`message-list ${!displayedMessages.length ? "message-list-empty" : ""}`}
              onScroll={handleMessageListScroll}
            >
              {isConversationLoading && displayedMessages.length > 0 && (
                <Box className="message-list-top">
                  <Chip size="small" label="Refreshing messages..." variant="outlined" />
                </Box>
              )}

              {hasOlderMessages && (
                <Box className="message-list-top">
                  <Button variant="text" size="small" onClick={handleLoadOlderMessages}>
                    Load earlier messages
                  </Button>
                </Box>
              )}

              {displayedMessages.map((message) => {
                const outgoing = message.senderUserId === currentUser?.id;

                return (
                  <Stack
                    key={message.id}
                    direction="row"
                    spacing={1.5}
                    justifyContent={outgoing ? "flex-end" : "flex-start"}
                    className={`message-row ${outgoing ? "message-row-outgoing" : "message-row-incoming"}`}
                  >
                    {!outgoing && (
                      <Avatar
                        src={message.senderAvatarUrl ?? undefined}
                        className="message-avatar"
                      >
                        {getInitial(message.senderDisplayName)}
                      </Avatar>
                    )}
                    <Stack
                      spacing={0.75}
                      alignItems={outgoing ? "flex-end" : "flex-start"}
                      className="message-content"
                    >
                      <Typography variant="caption" color="text.secondary" className="message-meta">
                        {message.senderDisplayName} · {formatDateTime(message.createdAt)}
                      </Typography>
                      <MarkdownMessage markdown={message.markdown} outgoing={outgoing} />
                      {message.clientStatus === "sending" && (
                        <Chip size="small" label="Sending..." variant="outlined" />
                      )}
                      {message.clientStatus === "failed" && (
                        <Chip size="small" label="Failed to send" color="error" variant="outlined" />
                      )}
                      {message.burnAfterRead && (
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          label="Burn after read"
                        />
                      )}
                    </Stack>
                  </Stack>
                );
              })}

              {isConversationLoading && !displayedMessages.length && (
                <Box className="empty-state empty-state-chat">
                  <CircularProgress size={28} />
                  <Typography variant="h6">Loading conversation</Typography>
                  <Typography color="text.secondary">
                    正在拉取并解密这个会话的消息，请稍等。
                  </Typography>
                </Box>
              )}

              {!isConversationLoading && !displayedMessages.length && (
                <Box className="empty-state empty-state-chat">
                  <Typography variant="h6">No messages yet</Typography>
                  <Typography color="text.secondary">
                    发送第一条消息后，这里会保持一个更接近原生聊天应用的时间线视图。
                  </Typography>
                </Box>
              )}
            </Box>

            {showNewMessageNotice && (
              <Box className="new-message-notice">
                <Button variant="contained" size="small" onClick={scrollToLatest}>
                  Jump to latest
                </Button>
              </Box>
            )}

            <Stack className="composer-panel" spacing={1.5}>
              <Stack direction="row" spacing={1.5} alignItems="flex-end">
                <TextField
                  fullWidth
                  multiline
                  maxRows={6}
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={activeConversationId ? "Write a secure message" : "Select a conversation first"}
                />
                <Button
                  variant="contained"
                  className="send-button"
                  endIcon={
                    isSendingMessage ? <CircularProgress size={16} color="inherit" /> : <SendRoundedIcon />
                  }
                  disabled={isSendingMessage || !activeConversationId || !composer.trim()}
                  onClick={handleSendMessage}
                >
                  Send
                </Button>
              </Stack>
              <Stack className="composer-meta" direction="row" justifyContent="space-between" gap={1.5}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  {TTL_PRESETS.map((preset) => (
                    <Chip
                      key={preset.value}
                      size="small"
                      label={preset.label}
                      clickable
                      color={selectedTtl === preset.value ? "primary" : "default"}
                      variant={selectedTtl === preset.value ? "filled" : "outlined"}
                      onClick={() => setSelectedTtl(preset.value)}
                    />
                  ))}
                </Stack>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography color="text.secondary" variant="body2">
                    {burnAfterRead ? "Burn after read" : `Auto delete ${selectedTtlPreset.label}`}
                  </Typography>
                  <Switch
                    checked={burnAfterRead}
                    onChange={(event) => setBurnAfterRead(event.target.checked)}
                  />
                </Stack>
              </Stack>
            </Stack>
          </Paper>
        )}

        {!isMobile && (
          <Paper className="detail-panel" elevation={0}>
            <ConversationDetailRail
              currentUser={currentUser}
              activeConversation={activeConversation}
              activeConversationMeta={
                activeConversationId ? conversationMeta[activeConversationId] ?? null : null
              }
              incomingRequestCount={incomingRequests.length}
              selectedTtlLabel={selectedTtlPreset.label}
              burnAfterRead={burnAfterRead}
              messageCount={messages.length}
              deviceLabel={device?.label ?? "This device"}
            />
          </Paper>
        )}
      </Box>
    </Box>
  );
}

function SidebarContent(props: {
  currentUser: User | null;
  conversations: ConversationSummary[];
  conversationMeta: Record<string, ConversationMeta>;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  friends: any[];
  requests: any[];
  friendEmail: string;
  setFriendEmail: (value: string) => void;
  onAddFriend: () => void;
  onAcceptRequest: (requestId: string) => void;
  onLogout: () => void;
  sidebarSection: SidebarSection;
  setSidebarSection: (value: SidebarSection) => void;
}) {
  const friendsWithoutConversation = props.friends.filter((friend: any) => !friend.conversationId);

  return (
    <Stack className="sidebar-content" spacing={2.5}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Avatar src={props.currentUser?.avatarUrl ?? undefined}>
            {getInitial(props.currentUser?.displayName)}
          </Avatar>
          <Box flex={1} minWidth={0}>
            <Typography variant="subtitle1" noWrap>
              {props.currentUser?.displayName}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {props.currentUser?.email}
            </Typography>
          </Box>
          <IconButton onClick={props.onLogout} aria-label="Sign out">
            <LogoutRoundedIcon />
          </IconButton>
        </Stack>

        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Chip
            icon={<ForumRoundedIcon />}
            label="Chats"
            clickable
            color={props.sidebarSection === "chats" ? "primary" : "default"}
            variant={props.sidebarSection === "chats" ? "filled" : "outlined"}
            onClick={() => props.setSidebarSection("chats")}
          />
          <Chip
            icon={<PersonAddRoundedIcon />}
            label="People"
            clickable
            color={props.sidebarSection === "people" ? "primary" : "default"}
            variant={props.sidebarSection === "people" ? "filled" : "outlined"}
            onClick={() => props.setSidebarSection("people")}
          />
          <Chip
            icon={<MailOutlineRoundedIcon />}
            label={`Requests ${props.requests.length > 0 ? props.requests.length : ""}`.trim()}
            clickable
            color={props.sidebarSection === "requests" ? "primary" : "default"}
            variant={props.sidebarSection === "requests" ? "filled" : "outlined"}
            onClick={() => props.setSidebarSection("requests")}
          />
        </Stack>
      </Stack>

      <Divider />

      {props.sidebarSection === "chats" && (
        <Stack spacing={1.5} minHeight={0}>
          <Box>
            <Typography variant="overline" color="text.secondary">
              Conversations
            </Typography>
            <Typography variant="h6">Recent secure threads</Typography>
          </Box>
          <List disablePadding className="conversation-list">
            {props.conversations.map((conversation) => {
              const meta = props.conversationMeta[conversation.id];
              return (
                <ListItemButton
                  key={conversation.id}
                  selected={props.activeConversationId === conversation.id}
                  onClick={() => props.onSelectConversation(conversation.id)}
                  className="conversation-item"
                >
                  <Avatar src={conversation.counterpart?.avatarUrl ?? undefined}>
                    {getInitial(conversation.counterpart?.displayName)}
                  </Avatar>
                  <ListItemText
                    disableTypography
                    primary={
                      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                        <Typography variant="body2" fontWeight={600} noWrap>
                          {conversation.counterpart?.displayName ?? "Direct conversation"}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatConversationTime(meta?.lastMessageAt)}
                        </Typography>
                      </Stack>
                    }
                    secondary={
                      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                        <Typography variant="body2" color="text.secondary" noWrap>
                          {meta?.preview || conversation.counterpart?.email || "Encrypted channel"}
                        </Typography>
                        {meta?.unreadCount ? (
                          <Badge color="primary" badgeContent={meta.unreadCount} />
                        ) : null}
                      </Stack>
                    }
                  />
                </ListItemButton>
              );
            })}
            {props.conversations.length === 0 && (
              <Box className="empty-state empty-state-sidebar">
                <Typography variant="body1">No conversations yet</Typography>
                <Typography variant="body2" color="text.secondary">
                  Add a person first, then start an encrypted thread.
                </Typography>
              </Box>
            )}
          </List>
        </Stack>
      )}

      {props.sidebarSection === "people" && (
        <Stack spacing={2}>
          <Box>
            <Typography variant="overline" color="text.secondary">
              People
            </Typography>
            <Typography variant="h6">Add or revisit contacts</Typography>
          </Box>
          <Paper variant="outlined" className="sidebar-card">
            <Stack spacing={1.25}>
              <Typography variant="subtitle2">Add a friend</Typography>
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
          </Paper>
          <Stack spacing={1.25}>
            {props.friends.map((friend: any) => (
              <Paper key={friend.id} variant="outlined" className="sidebar-card">
                <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1.5}>
                  <Box minWidth={0}>
                    <Typography variant="subtitle2" noWrap>
                      {friend.displayName}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {friend.email}
                    </Typography>
                  </Box>
                  {friend.conversationId ? (
                    <Button size="small" onClick={() => props.onSelectConversation(friend.conversationId)}>
                      Open chat
                    </Button>
                  ) : (
                    <Chip size="small" label="Connected" variant="outlined" />
                  )}
                </Stack>
              </Paper>
            ))}
            {props.friends.length === 0 && (
              <Typography color="text.secondary">
                Your contact book is empty for now.
              </Typography>
            )}
            {friendsWithoutConversation.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                These contacts are added but have not started a conversation yet.
              </Typography>
            )}
          </Stack>
        </Stack>
      )}

      {props.sidebarSection === "requests" && (
        <Stack spacing={2}>
          <Box>
            <Typography variant="overline" color="text.secondary">
              Requests
            </Typography>
            <Typography variant="h6">Pending approvals</Typography>
          </Box>
          <Stack spacing={1.25}>
            {props.requests.map((request: any) => (
              <Paper key={request.id} variant="outlined" className="sidebar-card">
                <Stack spacing={1}>
                  <Box>
                    <Typography variant="subtitle2">{request.counterparty.displayName}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {request.counterparty.email}
                    </Typography>
                  </Box>
                  <Button size="small" variant="contained" onClick={() => props.onAcceptRequest(request.id)}>
                    Accept
                  </Button>
                </Stack>
              </Paper>
            ))}
            {props.requests.length === 0 && (
              <Box className="empty-state empty-state-sidebar">
                <Typography variant="body1">No pending requests</Typography>
                <Typography variant="body2" color="text.secondary">
                  Incoming friend requests will appear here instead of competing with the chat list.
                </Typography>
              </Box>
            )}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

function ConversationDetailRail(props: {
  currentUser: User | null;
  activeConversation: ConversationSummary | null;
  activeConversationMeta: ConversationMeta | null;
  incomingRequestCount: number;
  selectedTtlLabel: string;
  burnAfterRead: boolean;
  messageCount: number;
  deviceLabel: string;
}) {
  return (
    <Stack className="detail-content" spacing={2.5}>
      <Stack spacing={1}>
        <Typography variant="overline" color="text.secondary">
          Workspace
        </Typography>
        <Typography variant="h6">Conversation details</Typography>
      </Stack>

      {props.activeConversation ? (
        <Paper variant="outlined" className="detail-card">
          <Stack spacing={2}>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Avatar src={props.activeConversation.counterpart?.avatarUrl ?? undefined}>
                {getInitial(props.activeConversation.counterpart?.displayName)}
              </Avatar>
              <Box minWidth={0}>
                <Typography variant="subtitle1" noWrap>
                  {props.activeConversation.counterpart?.displayName ?? "Direct conversation"}
                </Typography>
                <Typography variant="body2" color="text.secondary" noWrap>
                  {props.activeConversation.counterpart?.email}
                </Typography>
              </Box>
            </Stack>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <Chip icon={<ShieldRoundedIcon />} label="Encrypted" variant="outlined" />
              <Chip icon={<TimerOutlinedIcon />} label={`TTL ${props.selectedTtlLabel}`} variant="outlined" />
              {props.burnAfterRead && (
                <Chip icon={<WhatshotRoundedIcon />} label="Burn after read" color="warning" variant="outlined" />
              )}
            </Stack>
          </Stack>
        </Paper>
      ) : (
        <Paper variant="outlined" className="detail-card">
          <Stack spacing={1}>
            <Typography variant="subtitle2">No active thread</Typography>
            <Typography variant="body2" color="text.secondary">
              Select a conversation to show participant details, message policy, and thread context.
            </Typography>
          </Stack>
        </Paper>
      )}

      <Paper variant="outlined" className="detail-card">
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Current session</Typography>
          <DetailMetric label="Signed in as" value={props.currentUser?.displayName ?? "Unknown"} />
          <DetailMetric label="Device label" value={props.deviceLabel} />
          <DetailMetric label="Visible messages" value={String(props.messageCount)} />
          <DetailMetric label="Unread requests" value={String(props.incomingRequestCount)} />
        </Stack>
      </Paper>

      <Paper variant="outlined" className="detail-card">
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Thread snapshot</Typography>
          <DetailMetric
            label="Latest preview"
            value={props.activeConversationMeta?.preview || "No messages yet"}
          />
          <DetailMetric
            label="Unread in thread"
            value={String(props.activeConversationMeta?.unreadCount ?? 0)}
          />
          <DetailMetric
            label="Last activity"
            value={
              props.activeConversationMeta?.lastMessageAt
                ? formatDateTime(props.activeConversationMeta.lastMessageAt)
                : "Not available"
            }
          />
        </Stack>
      </Paper>
    </Stack>
  );
}

function DetailMetric(props: { label: string; value: string }) {
  return (
    <Stack spacing={0.35}>
      <Typography variant="caption" color="text.secondary">
        {props.label}
      </Typography>
      <Typography variant="body2">{props.value}</Typography>
    </Stack>
  );
}

function loadSeenMap(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    return JSON.parse(window.localStorage.getItem(SEEN_STORAGE_KEY) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function saveSeenMap(seenMap: Record<string, string>) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seenMap));
}

function toPreview(markdown: string): string {
  return markdown.replace(/[#*_`>\-\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 54) || "New message";
}

function getInitial(value: string | null | undefined) {
  return value?.trim().slice(0, 1).toUpperCase() || "?";
}

function formatConversationTime(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
