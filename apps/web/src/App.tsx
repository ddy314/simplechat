import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent
} from "react";
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
  type FriendRequestSummary,
  type FriendSummary,
  type OAuthProviderConfig,
  type SessionUser
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
  | { loading: false; user: SessionUser };

type User = SessionUser;

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
type WorkspaceStatus = "idle" | "hydrating" | "ready";

type SyncWorkspaceOptions = {
  targetConversationId?: string | null;
  forceConversation?: boolean;
  showLoader?: boolean;
  includeConversation?: boolean;
};

type WaitForServerStateOptions = {
  settled: () => boolean;
  syncOptions?: SyncWorkspaceOptions;
  timeoutMs?: number;
  intervalMs?: number;
};

const SEEN_STORAGE_KEY = "simplechat_seen_map";
const INITIAL_VISIBLE_MESSAGES = 80;
const MESSAGE_PAGE_SIZE = 80;
const AUTO_SCROLL_THRESHOLD = 96;
const BACKGROUND_SYNC_INTERVAL_MS = 3_000;
const MUTATION_CONFIRM_TIMEOUT_MS = 8_000;

export default function App() {
  const isMobile = useMediaQuery("(max-width:900px)");
  const [providers, setProviders] = useState<OAuthProviderConfig[]>([]);
  const [session, setSession] = useState<SessionState>({ loading: true });
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>("idle");
  const [device, setDevice] = useState<DeviceIdentity | null>(null);
  const [friends, setFriends] = useState<FriendSummary[]>([]);
  const [requests, setRequests] = useState<FriendRequestSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationCache, setConversationCache] = useState<
    Record<string, ConversationCacheEntry>
  >({});
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
  const lastRefreshAtRef = useRef(0);
  const previousMessageStateRef = useRef<{ conversationId: string | null; count: number }>({
    conversationId: null,
    count: 0
  });
  const currentUser = !session.loading ? session.user : null;
  const workspaceReady = Boolean(currentUser) && workspaceStatus === "ready";
  const showWorkspaceTransition = Boolean(currentUser) && workspaceStatus !== "ready";

  const activeConversationIdRef = useLatestRef(activeConversationId);
  const conversationCacheRef = useLatestRef(conversationCache);
  const currentUserRef = useLatestRef(currentUser);
  const deviceRef = useLatestRef(device);
  const messagesRef = useLatestRef(messages);
  const requestsRef = useLatestRef(requests);
  const conversationsRef = useLatestRef(conversations);
  const seenMapRef = useLatestRef(seenMap);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );
  const oauthProviders = useMemo(
    () => providers.filter((provider) => provider.id !== "local" && provider.enabled),
    [providers]
  );
  const incomingRequests = useMemo(
    () =>
      requests.filter(
        (request) => request.direction === "incoming" && request.status === "pending"
      ),
    [requests]
  );
  const displayedMessages = useMemo(
    () => messages.slice(-visibleMessageCount),
    [messages, visibleMessageCount]
  );
  const hasOlderMessages = displayedMessages.length < messages.length;
  const selectedTtlPreset =
    TTL_PRESETS.find((preset) => preset.value === selectedTtl) ?? TTL_PRESETS[0];
  const isConversationLoading =
    Boolean(activeConversationId) && loadingConversationId === activeConversationId;

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (session.loading) {
      return;
    }

    if (!currentUser) {
      resetWorkspaceState(false);
      return;
    }

    let cancelled = false;

    const hydrateWorkspace = async () => {
      setWorkspaceStatus("hydrating");

      try {
        const identity = await ensureDeviceIdentity();
        if (cancelled) {
          return;
        }

        await api.registerDevice({
          deviceId: identity.deviceId,
          label: identity.label,
          publicKey: identity.publicKey
        });
        if (cancelled) {
          return;
        }

        setDevice(identity);
        await syncWorkspace(
          {
            targetConversationId: activeConversationIdRef.current,
            forceConversation: true,
            showLoader: Boolean(activeConversationIdRef.current)
          },
          identity
        );
        if (cancelled) {
          return;
        }

        setWorkspaceStatus("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        setNotice(error instanceof Error ? error.message : "Failed to load encrypted workspace.");
        setWorkspaceStatus("ready");
      }
    };

    void hydrateWorkspace();

    return () => {
      cancelled = true;
      syncRequestRef.current += 1;
    };
  }, [currentUser?.id, session.loading]);

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
    if (!workspaceReady || !device || !activeConversationId) {
      return;
    }

    lastRefreshAtRef.current = Date.now();
    void syncWorkspace(
      {
        targetConversationId: activeConversationId,
        forceConversation: !conversationCacheRef.current[activeConversationId],
        showLoader: !conversationCacheRef.current[activeConversationId]
      },
      device
    );
  }, [activeConversationId, device?.deviceId, workspaceReady]);

  const triggerWorkspaceRefresh = useEffectEvent((options: SyncWorkspaceOptions = {}) => {
    if (!currentUserRef.current) {
      return;
    }

    if (document.visibilityState === "hidden" && !options.forceConversation) {
      return;
    }

    const now = Date.now();
    if (!options.forceConversation && now - lastRefreshAtRef.current < 1_200) {
      return;
    }

    lastRefreshAtRef.current = now;
    void syncWorkspace({
      targetConversationId: options.targetConversationId ?? activeConversationIdRef.current,
      forceConversation: options.forceConversation,
      showLoader: options.showLoader,
      includeConversation: options.includeConversation
    });
  });

  useEffect(() => {
    if (!workspaceReady || !device) {
      return;
    }

    const intervalId = window.setInterval(() => {
      triggerWorkspaceRefresh({
        targetConversationId: activeConversationIdRef.current
      });
    }, BACKGROUND_SYNC_INTERVAL_MS);

    const refreshNow = () => {
      triggerWorkspaceRefresh({
        targetConversationId: activeConversationIdRef.current
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshNow();
      }
    };

    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [device?.deviceId, workspaceReady]);

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

    if (activeConversationIdRef.current === conversationId) {
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
      if (activeConversationIdRef.current === conversationId) {
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

  function resetWorkspaceState(clearSeenState: boolean) {
    syncRequestRef.current += 1;
    lastRefreshAtRef.current = 0;
    readMarksRef.current.clear();
    pendingScrollOffsetRef.current = null;
    shouldStickToBottomRef.current = true;
    previousMessageStateRef.current = {
      conversationId: null,
      count: 0
    };

    setWorkspaceStatus("idle");
    setDevice(null);
    setFriends([]);
    setRequests([]);
    setConversations([]);
    setActiveConversationId(null);
    setConversationDetail(null);
    setMessages([]);
    setConversationCache({});
    setConversationMeta({});
    setComposer("");
    setFriendEmail("");
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setShowNewMessageNotice(false);
    setLoadingConversationId(null);
    setSidebarSection("chats");

    if (clearSeenState) {
      saveSeenMap({});
      setSeenMap({});
    }
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

  async function refreshConversationDetail(input: {
    conversationId: string;
    identity: DeviceIdentity;
    userId: string;
    requestId: number;
    markSeen: boolean;
  }) {
    const detail = await api.getConversation(input.conversationId);
    if (input.requestId !== syncRequestRef.current) {
      return;
    }

    const decrypted = await Promise.all(
      detail.messages.map((message) => decryptMessage(input.identity, message))
    );
    if (input.requestId !== syncRequestRef.current) {
      return;
    }

    const remoteMessages = decrypted.filter(
      (message): message is DecryptedMessage => message !== null
    );
    const existingMessages =
      conversationCacheRef.current[input.conversationId]?.messages ??
      (activeConversationIdRef.current === input.conversationId ? messagesRef.current : []);
    const visible = mergeRemoteMessages(remoteMessages, existingMessages);
    const unreadCount = input.markSeen
      ? 0
      : countUnreadMessages(
          visible,
          input.userId,
          seenMapRef.current[input.conversationId]
        );

    setConversationState(input.conversationId, detail, visible);
    setConversationMeta((previous) => ({
      ...previous,
      [input.conversationId]: {
        preview:
          visible.at(-1)?.markdown
            ? toPreview(visible.at(-1)!.markdown)
            : previous[input.conversationId]?.preview ??
              detail.conversation.counterpart?.email ??
              "Encrypted channel",
        unreadCount,
        lastMessageAt:
          visible.at(-1)?.createdAt ??
          detail.conversation.lastMessageAt ??
          previous[input.conversationId]?.lastMessageAt ??
          null
      }
    }));

    if (input.markSeen) {
      markConversationSeen(input.conversationId, visible);
    }

    for (const message of visible) {
      if (
        message.burnAfterRead &&
        message.senderUserId !== input.userId &&
        !readMarksRef.current.has(message.id)
      ) {
        readMarksRef.current.add(message.id);
        void api.markMessageRead(input.conversationId, message.id);
      }
    }

    setLoadingConversationId((current) =>
      current === input.conversationId ? null : current
    );
  }

  async function syncWorkspace(
    options: SyncWorkspaceOptions = {},
    identityOverride: DeviceIdentity | null = deviceRef.current
  ) {
    const user = currentUserRef.current;
    if (!user) {
      return;
    }

    if (options.includeConversation !== false && !identityOverride) {
      return;
    }

    const desiredConversationId =
      options.targetConversationId ?? activeConversationIdRef.current;
    const requestId = ++syncRequestRef.current;
    const shouldShowLoader = Boolean(desiredConversationId) && options.showLoader;

    if (shouldShowLoader && desiredConversationId) {
      setLoadingConversationId(desiredConversationId);
    }

    try {
      const snapshot = await api.getWorkspace();
      if (requestId !== syncRequestRef.current) {
        return;
      }

      const nextActiveConversationId = resolveNextActiveConversationId(
        desiredConversationId,
        snapshot.conversations,
        isMobile
      );

      setFriends(snapshot.friends);
      setRequests(snapshot.requests);
      setConversations(snapshot.conversations);
      setConversationMeta((previous) =>
        buildConversationMetaMap(
          snapshot.conversations,
          conversationCacheRef.current,
          previous,
          seenMapRef.current,
          user.id
        )
      );
      setActiveConversationId(nextActiveConversationId);

      if (
        options.includeConversation === false ||
        !nextActiveConversationId ||
        !identityOverride
      ) {
        return;
      }

      const targetConversation =
        snapshot.conversations.find((conversation) => conversation.id === nextActiveConversationId) ??
        null;
      if (
        !shouldRefreshConversationDetail(
          targetConversation,
          conversationCacheRef.current[nextActiveConversationId],
          options.forceConversation ?? false
        )
      ) {
        return;
      }

      await refreshConversationDetail({
        conversationId: nextActiveConversationId,
        identity: identityOverride,
        userId: user.id,
        requestId,
        markSeen: nextActiveConversationId === activeConversationIdRef.current
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to sync workspace.");
    } finally {
      if (shouldShowLoader && desiredConversationId && requestId === syncRequestRef.current) {
        setLoadingConversationId((current) =>
          current === desiredConversationId ? null : current
        );
      }
    }
  }

  const waitForServerState = useEffectEvent(
    async (options: WaitForServerStateOptions): Promise<boolean> => {
      if (options.settled()) {
        return true;
      }

      const timeoutMs = options.timeoutMs ?? MUTATION_CONFIRM_TIMEOUT_MS;
      const intervalMs = options.intervalMs ?? 700;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        await syncWorkspace(options.syncOptions);
        if (options.settled()) {
          return true;
        }

        await sleep(intervalMs);
      }

      return options.settled();
    }
  );

  function markConversationSeen(conversationId: string, visible: ChatMessage[]) {
    const latestMessage = visible.at(-1);
    if (!latestMessage) {
      return;
    }

    setSeenMap((previous) => {
      if (previous[conversationId] === latestMessage.createdAt) {
        return previous;
      }

      const nextSeenMap = {
        ...previous,
        [conversationId]: latestMessage.createdAt
      };
      saveSeenMap(nextSeenMap);
      return nextSeenMap;
    });

    setConversationMeta((previous) => ({
      ...previous,
      [conversationId]: {
        preview:
          latestMessage.markdown
            ? toPreview(latestMessage.markdown)
            : previous[conversationId]?.preview ?? "Encrypted channel",
        unreadCount: 0,
        lastMessageAt: latestMessage.createdAt
      }
    }));
  }

  async function handleSendMessage() {
    if (!composer.trim() || !activeConversationId || !device || !conversationDetail || !currentUser) {
      return;
    }

    const conversationId = activeConversationId;
    const markdown = composer.trim();
    const messageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + selectedTtl * 1000).toISOString();
    const optimisticMessage: ChatMessage = {
      id: messageId,
      senderUserId: currentUser.id,
      senderDisplayName: currentUser.displayName,
      senderAvatarUrl: currentUser.avatarUrl,
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
      conversationCacheRef.current[conversationId]?.detail ?? conversationDetail;
    if (currentDetail) {
      const existingMessages =
        conversationCacheRef.current[conversationId]?.messages ??
        (activeConversationIdRef.current === conversationId ? messagesRef.current : []);
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
      const recipients = conversationDetail.participantDevices.map((participant) => ({
        deviceId: participant.deviceId,
        publicKey: participant.publicKey
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

      void waitForServerState({
        syncOptions: {
          targetConversationId: conversationId,
          forceConversation: true
        },
        settled: () => {
          const cachedConversation = conversationCacheRef.current[conversationId];
          return (
            cachedConversation?.messages.some(
              (message) => message.id === messageId && !message.clientStatus
            ) ?? false
          );
        }
      });
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

    const normalizedEmail = friendEmail.trim().toLowerCase();
    setBusy(true);

    try {
      await api.createFriendRequest(normalizedEmail);
      setFriendEmail("");
      setSidebarSection("requests");
      await waitForServerState({
        syncOptions: {
          includeConversation: false
        },
        settled: () =>
          requestsRef.current.some(
            (request) =>
              request.counterparty.email.toLowerCase() === normalizedEmail &&
              request.status === "pending"
          )
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to send friend request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptRequest(requestId: string) {
    setBusy(true);

    try {
      const response = await api.acceptFriendRequest(requestId);
      setSidebarSection("chats");
      setActiveConversationId(response.conversationId);
      await waitForServerState({
        syncOptions: {
          targetConversationId: response.conversationId,
          forceConversation: true
        },
        settled: () =>
          conversationsRef.current.some(
            (conversation) => conversation.id === response.conversationId
          )
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to accept request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);

    try {
      await api.logout();
      window.localStorage.removeItem(SEEN_STORAGE_KEY);
      resetWorkspaceState(true);
      setSession({ loading: false, user: null });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to sign out.");
    } finally {
      setBusy(false);
    }
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

    setVisibleMessageCount((previous) =>
      Math.min(previous + MESSAGE_PAGE_SIZE, messages.length)
    );
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

  return (
    <Box className="shell-root">
      {!session.user && (
        <AuthScreen
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          authMode={authMode}
          setAuthMode={setAuthMode}
          authEmail={authEmail}
          setAuthEmail={setAuthEmail}
          authPassword={authPassword}
          setAuthPassword={setAuthPassword}
          authDisplayName={authDisplayName}
          setAuthDisplayName={setAuthDisplayName}
          oauthProviders={oauthProviders}
          busy={busy}
          onSubmit={handleLocalAuth}
        />
      )}

      {session.user && (
        <>
          <Box className={`app-shell-frame ${workspaceReady ? "app-shell-frame-ready" : ""}`}>
            <Box className="app-shell">
              {notice && (
                <Alert
                  severity="info"
                  onClose={() => setNotice(null)}
                  className="notice-banner"
                >
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
                        <IconButton
                          onClick={handleBackToList}
                          edge="start"
                          aria-label="Back to chats"
                        >
                          <ArrowBackRoundedIcon />
                        </IconButton>
                      )}
                      <Avatar src={activeConversation?.counterpart?.avatarUrl ?? undefined}>
                        {getInitial(activeConversation?.counterpart?.displayName)}
                      </Avatar>
                      <Box className="chat-header-copy">
                        <Typography variant="h6">
                          {activeConversation?.counterpart?.displayName ??
                            "Select a conversation"}
                        </Typography>
                        <Typography color="text.secondary">
                          {activeConversation?.counterpart?.email ??
                            "Pick a secure thread to start talking."}
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
                          <Chip
                            size="small"
                            label="Refreshing messages..."
                            variant="outlined"
                          />
                        </Box>
                      )}

                      {hasOlderMessages && (
                        <Box className="message-list-top">
                          <Button
                            variant="text"
                            size="small"
                            onClick={handleLoadOlderMessages}
                          >
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
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                className="message-meta"
                              >
                                {message.senderDisplayName} · {formatDateTime(message.createdAt)}
                              </Typography>
                              <MarkdownMessage markdown={message.markdown} outgoing={outgoing} />
                              {message.clientStatus === "sending" && (
                                <Chip size="small" label="Sending..." variant="outlined" />
                              )}
                              {message.clientStatus === "sent-local" && (
                                <Chip size="small" label="Syncing..." variant="outlined" />
                              )}
                              {message.clientStatus === "failed" && (
                                <Chip
                                  size="small"
                                  label="Failed to send"
                                  color="error"
                                  variant="outlined"
                                />
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
                          placeholder={
                            activeConversationId
                              ? "Write a secure message"
                              : "Select a conversation first"
                          }
                        />
                        <Button
                          variant="contained"
                          className="send-button"
                          endIcon={
                            isSendingMessage ? (
                              <CircularProgress size={16} color="inherit" />
                            ) : (
                              <SendRoundedIcon />
                            )
                          }
                          disabled={isSendingMessage || !activeConversationId || !composer.trim()}
                          onClick={handleSendMessage}
                        >
                          Send
                        </Button>
                      </Stack>
                      <Stack
                        className="composer-meta"
                        direction="row"
                        justifyContent="space-between"
                        gap={1.5}
                      >
                        <Stack
                          direction="row"
                          spacing={1}
                          alignItems="center"
                          flexWrap="wrap"
                          useFlexGap
                        >
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
                            {burnAfterRead
                              ? "Burn after read"
                              : `Auto delete ${selectedTtlPreset.label}`}
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
          </Box>

          <WorkspaceTransitionOverlay visible={showWorkspaceTransition} user={currentUser} />
        </>
      )}
    </Box>
  );
}

function AuthScreen(props: {
  notice: string | null;
  onDismissNotice: () => void;
  authMode: "login" | "register";
  setAuthMode: (value: "login" | "register") => void;
  authEmail: string;
  setAuthEmail: (value: string) => void;
  authPassword: string;
  setAuthPassword: (value: string) => void;
  authDisplayName: string;
  setAuthDisplayName: (value: string) => void;
  oauthProviders: OAuthProviderConfig[];
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <Box className="login-shell">
      <Paper className="login-card" elevation={0}>
        <Stack spacing={2.5}>
          {props.notice && (
            <Alert severity="error" onClose={props.onDismissNotice}>
              {props.notice}
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
                color={props.authMode === "login" ? "primary" : "default"}
                clickable
                onClick={() => props.setAuthMode("login")}
              />
              <Chip
                label="Register"
                color={props.authMode === "register" ? "primary" : "default"}
                clickable
                onClick={() => props.setAuthMode("register")}
              />
            </Stack>
            {props.authMode === "register" && (
              <TextField
                label="Display name"
                value={props.authDisplayName}
                onChange={(event) => props.setAuthDisplayName(event.target.value)}
              />
            )}
            <TextField
              label="Email"
              type="email"
              value={props.authEmail}
              onChange={(event) => props.setAuthEmail(event.target.value)}
            />
            <TextField
              label="Password"
              type="password"
              value={props.authPassword}
              onChange={(event) => props.setAuthPassword(event.target.value)}
              helperText={props.authMode === "register" ? "Minimum 10 characters" : undefined}
            />
            <Button
              variant="contained"
              size="large"
              onClick={props.onSubmit}
              disabled={props.busy}
            >
              {props.authMode === "register" ? "Create secure account" : "Sign in"}
            </Button>
            {props.oauthProviders.length > 0 && (
              <>
                <Divider />
                {props.oauthProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="outlined"
                    size="large"
                    href={`${
                      import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787"
                    }/auth/oauth/${provider.id}/start`}
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

function WorkspaceTransitionOverlay(props: { visible: boolean; user: User | null }) {
  return (
    <Box
      className={`workspace-transition ${
        props.visible ? "workspace-transition-visible" : ""
      }`}
    >
      <Paper className="workspace-transition-card" elevation={0}>
        <Stack spacing={2} alignItems="flex-start">
          <Chip label="Secure workspace" color="primary" variant="outlined" />
          <Stack spacing={0.75}>
            <Typography variant="h5">
              {props.user ? `Welcome back, ${props.user.displayName}` : "Preparing workspace"}
            </Typography>
            <Typography color="text.secondary">
              正在同步联系人、会话和最新消息，进入后会保持统一的等待与刷新节奏。
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              Loading encrypted threads...
            </Typography>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}

function SidebarContent(props: {
  currentUser: User | null;
  conversations: ConversationSummary[];
  conversationMeta: Record<string, ConversationMeta>;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  friends: FriendSummary[];
  requests: FriendRequestSummary[];
  friendEmail: string;
  setFriendEmail: (value: string) => void;
  onAddFriend: () => void;
  onAcceptRequest: (requestId: string) => void;
  onLogout: () => void;
  sidebarSection: SidebarSection;
  setSidebarSection: (value: SidebarSection) => void;
}) {
  const friendsWithoutConversation = props.friends.filter((friend) => !friend.conversationId);

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
                      <Stack
                        direction="row"
                        justifyContent="space-between"
                        alignItems="center"
                        gap={1}
                      >
                        <Typography variant="body2" fontWeight={600} noWrap>
                          {conversation.counterpart?.displayName ?? "Direct conversation"}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatConversationTime(meta?.lastMessageAt)}
                        </Typography>
                      </Stack>
                    }
                    secondary={
                      <Stack
                        direction="row"
                        justifyContent="space-between"
                        alignItems="center"
                        gap={1}
                      >
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
            {props.friends.map((friend) => (
              <Paper key={friend.id} variant="outlined" className="sidebar-card">
                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  gap={1.5}
                >
                  <Box minWidth={0}>
                    <Typography variant="subtitle2" noWrap>
                      {friend.displayName}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {friend.email}
                    </Typography>
                  </Box>
                  {friend.conversationId ? (
                    <Button
                      size="small"
                      onClick={() => props.onSelectConversation(friend.conversationId!)}
                    >
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
            {props.requests.map((request) => (
              <Paper key={request.id} variant="outlined" className="sidebar-card">
                <Stack spacing={1}>
                  <Box>
                    <Typography variant="subtitle2">{request.counterparty.displayName}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {request.counterparty.email}
                    </Typography>
                  </Box>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => props.onAcceptRequest(request.id)}
                  >
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
              <Chip
                icon={<TimerOutlinedIcon />}
                label={`TTL ${props.selectedTtlLabel}`}
                variant="outlined"
              />
              {props.burnAfterRead && (
                <Chip
                  icon={<WhatshotRoundedIcon />}
                  label="Burn after read"
                  color="warning"
                  variant="outlined"
                />
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

function useLatestRef<T>(value: T) {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}

function resolveNextActiveConversationId(
  desiredConversationId: string | null,
  conversations: ConversationSummary[],
  isMobile: boolean
) {
  if (
    desiredConversationId &&
    conversations.some((conversation) => conversation.id === desiredConversationId)
  ) {
    return desiredConversationId;
  }

  return isMobile ? null : conversations[0]?.id ?? null;
}

function shouldRefreshConversationDetail(
  conversation: ConversationSummary | null,
  cachedConversation: ConversationCacheEntry | undefined,
  force: boolean
) {
  if (!conversation) {
    return false;
  }

  if (force || !cachedConversation) {
    return true;
  }

  const hasPendingMessages = cachedConversation.messages.some((message) => message.clientStatus);
  const latestCachedMessageAt = cachedConversation.messages.at(-1)?.createdAt ?? null;

  return hasPendingMessages || conversation.lastMessageAt !== latestCachedMessageAt;
}

function countUnreadMessages(
  messages: ChatMessage[],
  userId: string | null,
  lastSeenAt: string | undefined
) {
  return messages.filter((message) => {
    if (message.senderUserId === userId) {
      return false;
    }

    if (!lastSeenAt) {
      return true;
    }

    return new Date(message.createdAt).getTime() > new Date(lastSeenAt).getTime();
  }).length;
}

function buildConversationMetaMap(
  conversations: ConversationSummary[],
  cache: Record<string, ConversationCacheEntry>,
  previous: Record<string, ConversationMeta>,
  seenMap: Record<string, string>,
  userId: string | null
) {
  const nextMeta: Record<string, ConversationMeta> = {};

  for (const conversation of conversations) {
    const cachedConversation = cache[conversation.id];
    if (cachedConversation?.messages.length) {
      const lastMessage = cachedConversation.messages.at(-1) ?? null;
      nextMeta[conversation.id] = {
        preview:
          lastMessage?.markdown
            ? toPreview(lastMessage.markdown)
            : previous[conversation.id]?.preview ??
              conversation.counterpart?.email ??
              "Encrypted channel",
        unreadCount: countUnreadMessages(
          cachedConversation.messages,
          userId,
          seenMap[conversation.id]
        ),
        lastMessageAt: lastMessage?.createdAt ?? conversation.lastMessageAt ?? null
      };
      continue;
    }

    const hasUnread =
      Boolean(conversation.lastMessageAt) &&
      (!seenMap[conversation.id] ||
        new Date(conversation.lastMessageAt!).getTime() >
          new Date(seenMap[conversation.id]).getTime());

    nextMeta[conversation.id] = {
      preview:
        previous[conversation.id]?.preview ??
        conversation.counterpart?.email ??
        "Encrypted channel",
      unreadCount: hasUnread ? Math.max(previous[conversation.id]?.unreadCount ?? 0, 1) : 0,
      lastMessageAt:
        conversation.lastMessageAt ?? previous[conversation.id]?.lastMessageAt ?? null
    };
  }

  return nextMeta;
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
  return (
    markdown.replace(/[#*_`>\-\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 54) ||
    "New message"
  );
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

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}
