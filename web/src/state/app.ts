import { api, ApiError, del, errorMessage, get, patch, post, put, setCsrfToken, setUnauthorizedHandler } from '../lib/api';
import { RealtimeClient } from '../lib/realtime';
import { navigate } from '../lib/router';
import { createStore } from '../lib/store';
import type { AppNotification, Conversation, ConversationRequest, Me, Message, PublicProfile, UploadedAttachment, ViewPolicy } from '../lib/types';
import { cleanMessageText, MAX_MESSAGE_CHARS } from '../lib/text';
import { uploadRaw } from '../lib/upload';
import { decrypt, E2EEError, encryptFor, initE2EE, invalidatePeer, isStaleKeyError, refreshPeer as refreshPeerKeys, resetE2EE } from './crypto';

export interface ConvMessages {
  items: Message[];
  hasMoreBefore: boolean;
  loaded: boolean;
  loadingOlder: boolean;
}

export type PendingKind = 'text' | 'image' | 'video' | 'audio' | 'voice' | 'file';

export interface Pending {
  clientId: string;
  conversationId: string;
  body: string;
  replyTo: Message | null;
  createdAt: string;
  state: 'uploading' | 'sending' | 'failed';
  error?: string;
  progress?: number;
  kind: PendingKind;
  file?: File | Blob;
  fileName?: string;
  policy?: ViewPolicy;
  previewUrl?: string;
  attachmentId?: string;
  durationMs?: number;
  attempts: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'message';
  action?: { label: string; run: () => void };
}

export interface AppState {
  boot: 'loading' | 'ready';
  me: Me | null;
  conversations: Record<string, Conversation>;
  conversationsLoaded: boolean;
  messages: Record<string, ConvMessages>;
  pending: Record<string, Pending>;
  presence: Record<string, { online: boolean | null; lastSeenAt: string | null }>;
  typing: Record<string, number>;
  requests: { incoming: ConversationRequest[]; outgoing: ConversationRequest[] };
  notifications: { items: AppNotification[]; unread: number };
  connection: 'connecting' | 'online' | 'offline';
  toasts: Toast[];
  activeConversationId: string | null;
  signedOutReason: string | null;
  profileVersion: Record<string, number>;
}

const initial: AppState = {
  boot: 'loading',
  me: null,
  conversations: {},
  conversationsLoaded: false,
  messages: {},
  pending: {},
  presence: {},
  typing: {},
  requests: { incoming: [], outgoing: [] },
  notifications: { items: [], unread: 0 },
  connection: 'connecting',
  toasts: [],
  activeConversationId: null,
  signedOutReason: null,
  profileVersion: {},
};

export const store = createStore<AppState>(initial);
export const useApp = store.useStore;
const S = store;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const idCmp = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => idCmp(a.id, b.id));
}

export const uuid = () =>
  crypto.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0]! & 15) >> 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

/** A content-free label for a message kind ("Photo", "View once video"). */
export function kindLabel(kind: string | null, viewPolicy: ViewPolicy | null | undefined): string {
  const label = ({ image: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', file: 'Document', text: 'Message' } as Record<string, string>)[kind ?? 'text'] ?? 'Message';
  if (viewPolicy === 'once') return `View once ${label.toLowerCase()}`;
  if (viewPolicy === 'twice') return `View twice ${label.toLowerCase()}`;
  return label;
}

export function systemText(ev: Message['system'], meId: string, peerName = 'They'): string {
  if (ev?.type === 'conversation_started') return 'Conversation started';
  if (ev?.type === 'ttl_changed') {
    const who = ev.actorId === meId ? 'You' : peerName;
    const t = ev.ttl;
    if (!t) return `${who} turned off disappearing messages`;
    return `${who} set messages to disappear after ${t === 86400 ? '24 hours' : t === 604800 ? '7 days' : '90 days'}`;
  }
  if (ev?.type === 'key_changed') return ev.userId === meId ? 'Your security code changed' : `${peerName}'s security code changed`;
  return 'Update';
}

/** The other participant of a message's conversation (needed to decrypt it). */
export function recipientOf(m: { conversationId: string; senderId: string | null }): string | null {
  const s = S.get();
  const peer = s.conversations[m.conversationId]?.peer?.id ?? null;
  if (!m.senderId) return null;
  return m.senderId === s.me?.id ? peer : (s.me?.id ?? null);
}

/** Decrypted text of a message ('' if it has none or cannot be decrypted). */
export async function textOf(m: Message): Promise<string> {
  if (!m.body || m.deleted || !m.senderId) return '';
  const r = recipientOf(m);
  if (!r) return '';
  return decrypt(m.body, m.senderId, r).catch(() => '');
}

let toastSeq = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = toastSeq++;
  S.set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind, action }] }));
  window.setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4500);
}
export const dismissToast = (id: number) => S.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

function setConv(c: Conversation) {
  S.set((s) => ({ conversations: { ...s.conversations, [c.id]: c } }));
}
function patchConv(id: string, p: Partial<Conversation>) {
  const c = S.get().conversations[id];
  if (c) setConv({ ...c, ...p });
}
function setMsgs(convId: string, fn: (m: ConvMessages) => ConvMessages) {
  S.set((s) => {
    const cur = s.messages[convId] ?? { items: [], hasMoreBefore: false, loaded: false, loadingOlder: false };
    return { messages: { ...s.messages, [convId]: fn(cur) } };
  });
}
function setPending(p: Pending | null, clientId: string) {
  S.set((s) => {
    const next = { ...s.pending };
    if (p) next[clientId] = p;
    else {
      const old = next[clientId];
      if (old?.previewUrl) URL.revokeObjectURL(old.previewUrl);
      delete next[clientId];
    }
    return { pending: next };
  });
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------
const rt = new RealtimeClient(
  (event, data) => handleEvent(event, data),
  (status, info) => {
    S.set({ connection: status });
    if (status === 'online' && !info?.firstConnect) void resync();
    if (status === 'online') flushOutbox();
  },
);
export const realtime = rt;

setUnauthorizedHandler(() => {
  if (S.get().me) endSession('Your session has ended. Please sign in again.');
});

export async function bootstrap() {
  try {
    const r = await api<{ me: Me; csrfToken: string }>('GET', '/api/auth/session', undefined, { quiet401: true });
    setCsrfToken(r.csrfToken);
    S.set({ me: r.me, boot: 'ready' });
    afterSignIn();
  } catch {
    S.set({ boot: 'ready', me: null });
  }
}

export function signedIn(me: Me, csrfToken: string) {
  setCsrfToken(csrfToken);
  S.set({ ...initial, boot: 'ready', me, signedOutReason: null });
  void afterSignIn();
}

/** After sign-in: once the profile exists and this device holds the encryption keys, start syncing. */
async function afterSignIn() {
  const me = S.get().me;
  if (!me?.setupComplete) return;
  const status = await initE2EE(me);
  if (status === 'ready') startSync();
  // Otherwise the app shows encryption setup / restore and calls encryptionReady() afterwards.
}

function startSync() {
  rt.start();
  void loadConversations();
  void loadRequests();
  void loadNotifications();
}

export function profileReady(me: Me) {
  S.set({ me });
  void afterSignIn();
}

export function encryptionReady(me?: Me) {
  if (me) S.set({ me });
  startSync();
}

/** `wipeKeys` removes this device's encryption keys (explicit sign-out, sign-out everywhere). */
function endSession(reason: string | null, wipeKeys = false) {
  rt.stop();
  for (const p of Object.values(S.get().pending)) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
  setCsrfToken('');
  void resetE2EE(wipeKeys);
  S.set({ ...initial, boot: 'ready', me: null, signedOutReason: reason });
  navigate('/login', { replace: true });
}

export async function signOut(all = false) {
  try {
    await post(all ? '/api/auth/logout-all' : '/api/auth/logout');
  } catch {
    /* signing out locally regardless */
  }
  endSession(null, true);
}

export async function refreshMe() {
  const r = await get<{ me: Me }>('/api/me');
  S.set({ me: r.me });
  return r.me;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------
export async function loadConversations() {
  try {
    const r = await get<{ conversations: Conversation[] }>('/api/conversations');
    const map: Record<string, Conversation> = {};
    for (const c of r.conversations) map[c.id] = c;
    S.set({ conversations: map, conversationsLoaded: true });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) toast(errorMessage(err), 'error');
  }
}

export async function loadConversation(id: string) {
  try {
    const r = await get<{ conversation: Conversation }>(`/api/conversations/${id}`);
    setConv(r.conversation);
    return r.conversation;
  } catch {
    return null;
  }
}

export async function loadRequests() {
  try {
    const r = await get<{ incoming: ConversationRequest[]; outgoing: ConversationRequest[] }>('/api/conversation-requests');
    S.set({ requests: r });
  } catch {
    /* non-fatal */
  }
}

export async function loadNotifications() {
  try {
    const r = await get<{ notifications: AppNotification[]; unreadCount: number }>('/api/notifications');
    S.set({ notifications: { items: r.notifications, unread: r.unreadCount } });
  } catch {
    /* non-fatal */
  }
}

export async function markNotificationsRead() {
  S.set((s) => ({ notifications: { items: s.notifications.items.map((n) => ({ ...n, read: true })), unread: 0 } }));
  await post('/api/notifications/read', {}).catch(() => {});
}

interface Page {
  messages: Message[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export async function loadLatest(convId: string) {
  const r = await get<Page>(`/api/conversations/${convId}/messages?limit=40`);
  setMsgs(convId, (m) => ({ ...m, items: mergeMessages(m.loaded ? m.items : [], r.messages), hasMoreBefore: m.loaded ? m.hasMoreBefore : r.hasMoreBefore, loaded: true }));
}

export async function loadOlder(convId: string) {
  const cur = S.get().messages[convId];
  if (!cur || cur.loadingOlder || !cur.hasMoreBefore) return;
  const first = cur.items[0];
  if (!first) return;
  setMsgs(convId, (m) => ({ ...m, loadingOlder: true }));
  try {
    const r = await get<Page>(`/api/conversations/${convId}/messages?limit=40&before=${first.id}`);
    setMsgs(convId, (m) => ({ ...m, items: mergeMessages(m.items, r.messages), hasMoreBefore: r.hasMoreBefore, loadingOlder: false }));
  } catch (err) {
    setMsgs(convId, (m) => ({ ...m, loadingOlder: false }));
    toast(errorMessage(err), 'error');
  }
}

/** Load the window of history around a message (used when jumping to a search result). */
export async function loadAround(convId: string, messageId: string) {
  const r = await get<Page>(`/api/conversations/${convId}/messages?limit=60&around=${messageId}`);
  // Replace the window: the gap between it and newer messages is refilled on scroll.
  setMsgs(convId, () => ({ items: r.messages, hasMoreBefore: r.hasMoreBefore, loaded: true, loadingOlder: false }));
  if (r.hasMoreAfter) void fillNewer(convId);
}

async function fillNewer(convId: string) {
  for (let i = 0; i < 20; i++) {
    const last = S.get().messages[convId]?.items.at(-1);
    if (!last) return;
    const r = await get<Page>(`/api/conversations/${convId}/messages?limit=100&after=${last.id}`);
    setMsgs(convId, (m) => ({ ...m, items: mergeMessages(m.items, r.messages) }));
    if (!r.hasMoreAfter) return;
  }
}

/** After a reconnect: refresh the list and fetch everything missed in loaded conversations. */
async function resync() {
  await loadConversations();
  void loadRequests();
  void loadNotifications();
  const s = S.get();
  for (const convId of Object.keys(s.messages)) {
    if (!s.conversations[convId]) continue;
    if (convId === s.activeConversationId) await loadLatest(convId).catch(() => {});
    await fillNewer(convId).catch(() => {});
  }
  const active = S.get().activeConversationId;
  if (active) markRead(active);
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------
let readTimer: number | undefined;
export function markRead(convId: string) {
  window.clearTimeout(readTimer);
  readTimer = window.setTimeout(() => {
    const s = S.get();
    if (document.visibilityState !== 'visible' || s.activeConversationId !== convId) return;
    const items = s.messages[convId]?.items ?? [];
    const meId = s.me?.id;
    const lastFromPeer = [...items].reverse().find((m) => m.senderId && m.senderId !== meId);
    const conv = s.conversations[convId];
    if (!lastFromPeer || !conv) return;
    if (idCmp(lastFromPeer.id, conv.lastReadMessageId) <= 0 && conv.unreadCount === 0) return;
    patchConv(convId, { unreadCount: 0, lastReadMessageId: lastFromPeer.id });
    void post(`/api/conversations/${convId}/read`, { messageId: lastFromPeer.id }).catch(() => {});
  }, 250);
}

document.addEventListener('visibilitychange', () => {
  const active = S.get().activeConversationId;
  if (active && document.visibilityState === 'visible') markRead(active);
  updateTitle();
});

export function setActiveConversation(id: string | null) {
  S.set({ activeConversationId: id });
  if (id) markRead(id);
}

function updateTitle() {
  const unread = Object.values(S.get().conversations).filter((c) => !c.archived && !c.muted && c.unreadCount > 0).length;
  document.title = unread ? `(${unread}) Cove` : 'Cove';
}
store.subscribe(() => updateTitle());

// ---------------------------------------------------------------------------
// sending (outbox)
// ---------------------------------------------------------------------------
const MAX_AUTO_RETRIES = 6;

export function sendText(convId: string, text: string, replyTo: Message | null) {
  const body = cleanMessageText(text).slice(0, MAX_MESSAGE_CHARS);
  if (!body) return;
  const p: Pending = { clientId: uuid(), conversationId: convId, body, replyTo, createdAt: new Date().toISOString(), state: 'sending', kind: 'text', attempts: 0 };
  setPending(p, p.clientId);
  void deliver(p.clientId);
}

export function sendFile(convId: string, file: File | Blob, opts: { caption?: string; policy?: ViewPolicy; voice?: boolean; durationMs?: number; replyTo?: Message | null; fileName?: string }) {
  const type = file.type;
  const kind: PendingKind = opts.voice ? 'voice' : type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file';
  const previewUrl = kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : undefined;
  const p: Pending = {
    clientId: uuid(),
    conversationId: convId,
    body: cleanMessageText(opts.caption ?? '').slice(0, MAX_MESSAGE_CHARS),
    replyTo: opts.replyTo ?? null,
    createdAt: new Date().toISOString(),
    state: 'uploading',
    progress: 0,
    kind,
    file,
    fileName: opts.fileName ?? (file instanceof File ? file.name : 'Voice message'),
    policy: opts.policy ?? 'normal',
    previewUrl,
    durationMs: opts.durationMs,
    attempts: 0,
  };
  setPending(p, p.clientId);
  void deliver(p.clientId);
}

const aborters = new Map<string, () => void>();

const inflight = new Set<string>();
const waitingForNetwork = new Set<string>();

window.addEventListener('online', () => {
  waitingForNetwork.clear();
  flushOutbox();
});

async function deliver(clientId: string) {
  if (inflight.has(clientId)) return;
  inflight.add(clientId);
  try {
    await deliverOnce(clientId);
  } finally {
    inflight.delete(clientId);
  }
}

async function deliverOnce(clientId: string) {
  let p = S.get().pending[clientId];
  if (!p || p.state === 'failed') return;
  try {
    if (p.file && !p.attachmentId) {
      setPending({ ...p, state: 'uploading', progress: 0, error: undefined }, clientId);
      const q = new URLSearchParams({ conversationId: p.conversationId, name: p.fileName ?? 'file', policy: p.policy ?? 'normal', voice: p.kind === 'voice' ? '1' : '0' });
      const up = uploadRaw<{ attachment: UploadedAttachment }>(`/api/uploads?${q}`, p.file, (f) => {
        const cur = S.get().pending[clientId];
        if (cur) setPending({ ...cur, progress: f }, clientId);
      });
      aborters.set(clientId, up.abort);
      const r = await up.promise;
      aborters.delete(clientId);
      p = S.get().pending[clientId];
      if (!p) return;
      p = { ...p, attachmentId: r.attachment.id, state: 'sending', progress: 1 };
      setPending(p, clientId);
    }
    // Text and captions are encrypted on this device; the server only ever receives the envelope.
    const conv = S.get().conversations[p.conversationId];
    const peerId = conv?.peer?.id;
    if (p.body && !peerId) throw new ApiError(404, 'not_found', 'This conversation is no longer available.');
    const envelope = p.body ? await encryptFor(peerId!, p.body, conv!.peerKeyId) : '';
    const r = await post<{ message: Message }>(`/api/conversations/${p.conversationId}/messages`, {
      clientId,
      body: envelope,
      attachmentId: p.attachmentId,
      replyToId: p.replyTo?.id,
    });
    acceptOwnMessage(r.message);
  } catch (err) {
    aborters.delete(clientId);
    const cur = S.get().pending[clientId];
    if (!cur) return;
    if (err instanceof E2EEError) {
      setPending({ ...cur, state: 'failed', error: err.message }, clientId);
      return;
    }
    const e = err as ApiError;
    if (e.code === 'aborted') return;
    if (isStaleKeyError(e) && cur.attempts < 3) {
      // A key changed since we last looked: fetch the new key and re-encrypt right away.
      const conv = S.get().conversations[cur.conversationId];
      if (conv?.peer) {
        patchConv(conv.id, { peerKeyId: (e.extra.recipientKid as string) ?? conv.peerKeyId });
        await refreshPeerKeys(conv.peer.id);
      }
      setPending({ ...cur, attempts: cur.attempts + 1 }, clientId);
      window.setTimeout(() => void deliver(clientId), 0);
      return;
    }
    const transient = e instanceof ApiError && (e.isNetwork || e.status >= 500 || e.status === 429);
    const offline = e instanceof ApiError && e.isNetwork && !navigator.onLine;
    if (transient && (offline || cur.attempts < MAX_AUTO_RETRIES)) {
      // Waiting for the network doesn't use up retries: the message goes out when the connection returns.
      const next = { ...cur, attempts: offline ? cur.attempts : cur.attempts + 1, state: cur.attachmentId || !cur.file ? ('sending' as const) : ('uploading' as const), error: undefined };
      setPending(next, clientId);
      if (offline) {
        waitingForNetwork.add(clientId);
        return;
      }
      const delay = e.status === 429 ? Number(e.extra.retryAfterSeconds ?? 2) * 1000 : Math.min(15_000, 1000 * 2 ** cur.attempts);
      window.setTimeout(() => {
        if (navigator.onLine) void deliver(clientId);
        else waitingForNetwork.add(clientId);
      }, delay);
      return;
    }
    setPending({ ...cur, state: 'failed', error: errorMessage(err) }, clientId);
  }
}

/** Resend everything still waiting once we are back online. */
function flushOutbox() {
  for (const p of Object.values(S.get().pending)) if (p.state !== 'failed' && !aborters.has(p.clientId) && !inflight.has(p.clientId)) void deliver(p.clientId);
}

export function retryPending(clientId: string) {
  const p = S.get().pending[clientId];
  if (!p) return;
  setPending({ ...p, state: p.file && !p.attachmentId ? 'uploading' : 'sending', error: undefined, attempts: 0 }, clientId);
  void deliver(clientId);
}

export function discardPending(clientId: string) {
  aborters.get(clientId)?.();
  aborters.delete(clientId);
  setPending(null, clientId);
}

window.addEventListener('beforeunload', (e) => {
  if (Object.values(S.get().pending).some((p) => p.state !== 'failed')) e.preventDefault();
});

function acceptOwnMessage(m: Message) {
  if (m.clientId) setPending(null, m.clientId);
  addMessage(m);
}

const lastMessageOf = (m: Message): NonNullable<Conversation['lastMessage']> => ({
  id: m.id,
  senderId: m.senderId,
  kind: m.kind,
  preview: m.deleted ? 'This message was deleted' : kindLabel(m.kind, m.attachment?.viewPolicy),
  body: m.deleted ? '' : m.body,
  system: m.system,
  viewPolicy: m.attachment?.viewPolicy ?? null,
  createdAt: m.createdAt,
  deleted: m.deleted,
  status: m.status,
});

function addMessage(m: Message) {
  const s = S.get();
  if (s.messages[m.conversationId]?.loaded) setMsgs(m.conversationId, (cur) => ({ ...cur, items: mergeMessages(cur.items, [m]) }));
  const conv = s.conversations[m.conversationId];
  if (conv) {
    const isNewer = !conv.lastMessage || idCmp(m.id, conv.lastMessage.id) >= 0;
    if (isNewer) patchConv(m.conversationId, { lastMessage: lastMessageOf(m), lastActivityAt: m.createdAt });
  }
}

// ---------------------------------------------------------------------------
// message actions
// ---------------------------------------------------------------------------
export async function editMessage(m: Message, raw: string) {
  const text = cleanMessageText(raw).slice(0, MAX_MESSAGE_CHARS);
  if (!text && m.kind === 'text') throw new ApiError(400, 'empty_message', "Message can't be empty.");
  const conv = S.get().conversations[m.conversationId];
  if (!conv?.peer) throw new ApiError(404, 'not_found', 'This conversation is no longer available.');
  for (let attempt = 0; ; attempt++) {
    const body = await encryptFor(conv.peer.id, text, S.get().conversations[m.conversationId]?.peerKeyId);
    try {
      await patch(`/api/messages/${m.id}`, { body });
      return;
    } catch (err) {
      if (!isStaleKeyError(err) || attempt >= 2) throw err;
      await refreshPeerKeys(conv.peer.id);
    }
  }
}
export async function deleteMessage(m: Message, scope: 'me' | 'everyone') {
  await del(`/api/messages/${m.id}?for=${scope}`);
  if (scope === 'me') removeMessage(m.conversationId, m.id);
}
export async function react(m: Message, emoji: string | null) {
  if (emoji) await put(`/api/messages/${m.id}/reaction`, { emoji });
  else await del(`/api/messages/${m.id}/reaction`);
}
/** Forward: decrypt here, re-encrypt for each target conversation's participant. */
export async function forward(m: Message, conversationIds: string[]) {
  const text = await textOf(m);
  const convs = S.get().conversations;
  const build = async () =>
    Promise.all(
      conversationIds.map(async (id) => {
        const c = convs[id];
        const body = text && c?.peer ? await encryptFor(c.peer.id, text, c.peerKeyId) : '';
        return { conversationId: id, clientId: uuid(), body };
      }),
    );
  let targets = await build();
  try {
    return await post<{ forwardedTo: string[] }>(`/api/messages/${m.id}/forward`, { targets });
  } catch (err) {
    if (!isStaleKeyError(err)) throw err;
    for (const id of conversationIds) {
      const peer = convs[id]?.peer?.id;
      if (peer) await refreshPeerKeys(peer);
    }
    targets = await build();
    return post<{ forwardedTo: string[] }>(`/api/messages/${m.id}/forward`, { targets });
  }
}

/** Report a user. With a message, its text (decrypted here) is shared only if the user agrees. */
export async function reportUser(userId: string, opts: { reason: string; details?: string; message?: Message | null; includeText?: boolean; block?: boolean }) {
  const excerpt = opts.message && opts.includeText ? await textOf(opts.message) : undefined;
  await post('/api/reports', { userId, messageId: opts.message?.id, reason: opts.reason, details: opts.details, excerpt: excerpt || undefined, block: opts.block });
}

function removeMessage(convId: string, id: string) {
  setMsgs(convId, (cur) => ({ ...cur, items: cur.items.filter((x) => x.id !== id) }));
}

export async function updateConversation(id: string, p: Partial<Pick<Conversation, 'archived' | 'muted' | 'messageTtlSeconds' | 'allowProtectedMedia'>>) {
  const r = await patch<{ conversation: Conversation }>(`/api/conversations/${id}`, p);
  setConv(r.conversation);
}

export async function deleteConversation(id: string) {
  await del(`/api/conversations/${id}`);
  removeConversationLocal(id);
}

function removeConversationLocal(id: string) {
  S.set((s) => {
    const conversations = { ...s.conversations };
    delete conversations[id];
    const messages = { ...s.messages };
    delete messages[id];
    return { conversations, messages };
  });
  if (S.get().activeConversationId === id) navigate('/', { replace: true });
}

export async function startConversation(userId: string, note?: string): Promise<{ conversation?: Conversation; request?: ConversationRequest }> {
  // The optional note is end-to-end encrypted to the recipient.
  const clean = cleanMessageText(note ?? '').slice(0, 280);
  const body = async () => (clean ? await encryptFor(userId, clean) : undefined);
  let r: { conversation?: Conversation; request?: ConversationRequest };
  try {
    r = await post('/api/conversations', { userId, note: await body() });
  } catch (err) {
    if (!isStaleKeyError(err)) throw err;
    await refreshPeerKeys(userId);
    r = await post('/api/conversations', { userId, note: await body() });
  }
  if (r.conversation) setConv(r.conversation);
  if (r.request) void loadRequests();
  return r;
}

/** Peers whose request this user just accepted (their new chat shouldn't announce itself). */
const acceptedByMe = new Set<string>();

export async function respondToRequest(id: string, action: 'accept' | 'reject' | 'cancel') {
  const req = S.get().requests.incoming.find((r) => r.id === id);
  if (action === 'accept' && req) acceptedByMe.add(req.user.id);
  const r = await post<{ conversation: Conversation | null }>(`/api/conversation-requests/${id}/${action}`);
  if (r.conversation) setConv(r.conversation);
  await loadRequests();
  return r.conversation;
}

// ---------------------------------------------------------------------------
// realtime events
// ---------------------------------------------------------------------------
let typingSweep: number | undefined;

function handleEvent(event: string, data: any) {
  const s = S.get();
  const meId = s.me?.id;
  switch (event) {
    case 'message:new': {
      const m = data.message as Message;
      if (m.senderId === meId) {
        acceptOwnMessage(m);
        return;
      }
      if (!s.conversations[m.conversationId]) {
        void loadConversation(m.conversationId);
        return;
      }
      addMessage(m);
      S.set((st) => {
        const t = { ...st.typing };
        delete t[m.conversationId];
        return { typing: t };
      });
      const conv = S.get().conversations[m.conversationId]!;
      const viewing = s.activeConversationId === m.conversationId && document.visibilityState === 'visible';
      if (m.kind !== 'system') {
        if (viewing) markRead(m.conversationId);
        else {
          patchConv(m.conversationId, { unreadCount: conv.unreadCount + 1 });
          if (!conv.muted && s.me?.notifications.inAppMessages) {
            // Notifications never include message content (it is end-to-end encrypted and private by default).
            const name = conv.peer?.displayName ?? 'Someone';
            const what = m.kind === 'text' ? 'New message' : kindLabel(m.kind, m.attachment?.viewPolicy);
            toast(`${name} · ${what}`, 'message', { label: 'Open', run: () => navigate(`/c/${m.conversationId}`) });
            if (s.me.notifications.sound) chime();
            if (document.visibilityState !== 'visible') pageNotification(name, what, m.conversationId);
          }
        }
      }
      return;
    }
    case 'message:updated': {
      const m = data.message as Message;
      if (s.messages[m.conversationId]?.loaded) setMsgs(m.conversationId, (cur) => ({ ...cur, items: mergeMessages(cur.items, [m]) }));
      const conv = s.conversations[m.conversationId];
      if (conv?.lastMessage?.id === m.id) patchConv(m.conversationId, { lastMessage: { ...lastMessageOf(m), status: conv.lastMessage.status } });
      return;
    }
    case 'message:removed':
      removeMessage(data.conversationId, data.messageId);
      return;
    case 'message:status': {
      const ids = new Set<string>(data.messageIds);
      const rank = { sent: 0, delivered: 1, read: 2 } as const;
      setMsgs(data.conversationId, (cur) => ({
        ...cur,
        items: cur.items.map((m) => (ids.has(m.id) && m.status && rank[data.status as 'read'] > rank[m.status] ? { ...m, status: data.status } : m)),
      }));
      const conv = s.conversations[data.conversationId];
      if (conv?.lastMessage && ids.has(conv.lastMessage.id)) patchConv(conv.id, { lastMessage: { ...conv.lastMessage, status: data.status } });
      return;
    }
    case 'conversation:updated': {
      const c = data.conversation as Conversation;
      const known = s.conversations[c.id];
      setConv(c);
      if (!known && c.peer && !acceptedByMe.has(c.peer.id)) {
        const name = c.peer.displayName;
        const open = { label: 'Open', run: () => navigate(`/c/${c.id}`) };
        if (s.requests.outgoing.some((r) => r.user.id === c.peer!.id)) {
          toast(`${name} accepted your message request`, 'message', open);
          void loadRequests();
        } else if (c.lastMessage && c.lastMessage.senderId !== meId) toast(`${name} started a conversation`, 'message', open);
      }
      return;
    }
    case 'conversation:removed':
      removeConversationLocal(data.conversationId);
      return;
    case 'conversation:read':
      patchConv(data.conversationId, { unreadCount: 0, lastReadMessageId: data.lastReadMessageId });
      return;
    case 'typing': {
      S.set((st) => {
        const t = { ...st.typing };
        if (data.typing) t[data.conversationId] = Date.now() + 6000;
        else delete t[data.conversationId];
        return { typing: t };
      });
      window.clearInterval(typingSweep);
      typingSweep = window.setInterval(() => {
        const now = Date.now();
        const t = S.get().typing;
        const live = Object.fromEntries(Object.entries(t).filter(([, exp]) => exp > now));
        if (Object.keys(live).length !== Object.keys(t).length) S.set({ typing: live });
        if (!Object.keys(live).length) window.clearInterval(typingSweep);
      }, 1500);
      return;
    }
    case 'presence':
      S.set((st) => ({ presence: { ...st.presence, [data.userId]: { online: data.online, lastSeenAt: data.lastSeenAt } } }));
      return;
    case 'request:new':
      S.set((st) => ({ requests: { ...st.requests, incoming: [data.request, ...st.requests.incoming.filter((r) => r.id !== data.request.id)] } }));
      toast(`${data.request.user.displayName} wants to message you`, 'message', { label: 'View', run: () => navigate('/requests') });
      return;
    case 'request:updated':
      void loadRequests();
      return;
    case 'notification:new':
      S.set((st) => ({ notifications: { items: [data, ...st.notifications.items], unread: st.notifications.unread + 1 } }));
      if (data.type === 'security_session_replaced') toast('Your previous session on another device was signed out.', 'info');
      return;
    case 'user:updated':
    case 'user:deleted': {
      S.set((st) => ({ profileVersion: { ...st.profileVersion, [data.userId]: (st.profileVersion[data.userId] ?? 0) + 1 } }));
      void refreshPeer(data.userId);
      return;
    }
    case 'me:updated':
      void refreshMe().catch(() => {});
      return;
    case 'user:keys': {
      // A contact's identity key changed: drop cached keys so we encrypt to the new one.
      invalidatePeer(data.userId);
      for (const c of Object.values(S.get().conversations)) if (c.peer?.id === data.userId) patchConv(c.id, { peerKeyId: data.kid });
      return;
    }
    case 'session:revoked': {
      const reasons: Record<string, string> = {
        replaced: 'You signed in on another device, so this session was ended.',
        logout_all: 'All sessions were signed out.',
        revoked: 'This session was ended from another device.',
        account_deleted: 'Your account was deleted.',
        expired: 'Your session expired. Please sign in again.',
        logout: 'You signed out.',
      };
      // Keys stay on the device when you simply signed in elsewhere; they are wiped when the
      // session was ended deliberately (sign out everywhere, ended remotely, account deleted).
      const wipe = ['logout_all', 'revoked', 'account_deleted', 'logout'].includes(data.reason);
      endSession(reasons[data.reason] ?? 'Your session has ended.', wipe);
      return;
    }
  }
}

async function refreshPeer(userId: string) {
  const convs = Object.values(S.get().conversations).filter((c) => c.peer?.id === userId);
  for (const c of convs) await loadConversation(c.id);
}

export async function fetchProfile(userId: string): Promise<{ user: PublicProfile; conversationId: string | null }> {
  return get(`/api/users/${userId}`);
}

let audioCtx: AudioContext | null = null;
/** A soft two-note chime generated in-browser (no audio asset needed). */
function chime() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.08, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.32);
    }
  } catch {
    /* audio unavailable */
  }
}

/** System notification from the open (background) tab when Web Push is not configured. Never includes content. */
function pageNotification(name: string, what: string, conversationId: string) {
  const me = S.get().me;
  if (!me?.notifications.pushEnabled || me.pushPublicKey || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(me.notifications.pushShowPreview ? name : 'Cove', { body: me.notifications.pushShowPreview ? what : 'New message', tag: conversationId, icon: '/icon-192.png' });
    n.onclick = () => {
      window.focus();
      navigate(`/c/${conversationId}`);
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

// Service worker asks us to navigate after a notification click.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'navigate') {
    const u = new URL(e.data.url);
    if (u.origin === location.origin) navigate(u.pathname);
  }
});

// ---------------------------------------------------------------------------
// contacts & history helpers
// ---------------------------------------------------------------------------
export async function setBlocked(userId: string, blocked: boolean) {
  if (blocked) await post(`/api/users/${userId}/block`);
  else await del(`/api/users/${userId}/block`);
  for (const c of Object.values(S.get().conversations)) if (c.peer?.id === userId) await loadConversation(c.id);
}

/**
 * Pull a conversation's whole history into memory so it can be searched on this device
 * (message text is end-to-end encrypted, so the server cannot search it).
 */
export async function loadEntireHistory(convId: string, onProgress?: (count: number) => void, maxPages = 60): Promise<boolean> {
  if (!S.get().messages[convId]?.loaded) await loadLatest(convId);
  for (let i = 0; i < maxPages; i++) {
    const cur = S.get().messages[convId];
    const first = cur?.items[0];
    if (!cur?.hasMoreBefore || !first) return true;
    const r = await get<Page>(`/api/conversations/${convId}/messages?limit=100&before=${first.id}`);
    setMsgs(convId, (m) => ({ ...m, items: mergeMessages(m.items, r.messages), hasMoreBefore: r.hasMoreBefore }));
    onProgress?.(S.get().messages[convId]?.items.length ?? 0);
  }
  return !S.get().messages[convId]?.hasMoreBefore;
}

export const conversationPeer = (convId: string) => S.get().conversations[convId]?.peer ?? null;
