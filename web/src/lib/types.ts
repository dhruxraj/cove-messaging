export type Audience = 'everyone' | 'contacts' | 'nobody';
export type ViewPolicy = 'normal' | 'once' | 'twice';
export type MessageStatus = 'sent' | 'delivered' | 'read';

export interface Me {
  id: string;
  email: string;
  createdAt: string;
  username: string | null;
  displayName: string | null;
  bio: string;
  avatarUrl: string | null;
  setupComplete: boolean;
  privacy: {
    profilePhoto: Audience;
    onlineStatus: Audience;
    lastSeen: Audience;
    readReceipts: boolean;
    whoCanMessage: 'everyone' | 'requests' | 'nobody';
    autoDownloadMedia: boolean;
    defaultMessageTtlSeconds: number | null;
    allowProtectedMedia: boolean;
  };
  notifications: { inAppMessages: boolean; pushEnabled: boolean; pushShowPreview: boolean; sound: boolean };
  limits: {
    editWindowMinutes: number;
    deleteWindowMinutes: number;
    maxImageMb: number;
    maxVideoMb: number;
    maxAudioMb: number;
    maxFileMb: number;
    maxAvatarMb: number;
    maxProtectedMb: number;
  };
  pushPublicKey: string | null;
  encryption: { keyId: string; createdAt: string; hasBackup: boolean } | null;
}

export interface PublicProfile {
  id: string;
  username: string | null;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  joinedAt: string;
  presence: { online: boolean | null; lastSeenAt: string | null };
  isContact: boolean;
  blockedByMe: boolean;
  deleted?: boolean;
}

export interface NormalAttachment {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  mime: string;
  fileName: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  viewPolicy: 'normal';
  hasThumbnail: boolean;
  available: boolean;
}

export interface ProtectedAttachment {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'voice';
  mime: string;
  size: number;
  durationMs: number | null;
  viewPolicy: 'once' | 'twice';
  viewLimit: number | null;
  viewsUsed: number;
  viewsRemaining: number;
  state: 'unopened' | 'partially_viewed' | 'opened' | 'expired';
  canView: boolean;
}

export type Attachment = NormalAttachment | ProtectedAttachment;

export interface Message {
  id: string;
  conversationId: string;
  senderId: string | null;
  clientId: string | null;
  kind: 'text' | 'image' | 'video' | 'audio' | 'voice' | 'file' | 'system';
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  forwarded: boolean;
  expiresAt: string | null;
  system: { type: string; actorId?: string; userId?: string; ttl?: number | null } | null;
  /** `body` is the quoted message's encrypted text; `preview` is a content-free fallback label. */
  replyTo: { id: string; senderId: string | null; kind: string | null; preview: string; body: string; viewPolicy: ViewPolicy | null; deleted: boolean; unavailable: boolean } | null;
  reactions: { emoji: string; userId: string }[];
  status?: MessageStatus;
  attachment: Attachment | null;
}

export interface Conversation {
  id: string;
  peer: PublicProfile | null;
  createdAt: string;
  lastActivityAt: string;
  lastMessage: {
    id: string;
    senderId: string | null;
    kind: string | null;
    /** Content-free label from the server ("Photo", "Message"); the client decrypts `body` for real previews. */
    preview: string;
    body: string;
    system: Message['system'];
    viewPolicy: ViewPolicy | null;
    createdAt: string;
    deleted: boolean;
    status?: MessageStatus;
  } | null;
  unreadCount: number;
  lastReadMessageId: string;
  archived: boolean;
  muted: boolean;
  messageTtlSeconds: number | null;
  allowProtectedMedia: boolean | null;
  peerAcceptsProtectedMedia: boolean;
  readReceiptsActive: boolean;
  peerKeyId: string | null;
}

export interface ConversationRequest {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  note: string;
  createdAt: string;
  conversationId: string | null;
  user: PublicProfile;
}

export interface AppNotification {
  id: string;
  type: 'conversation_request' | 'request_accepted' | 'security_session_replaced' | 'security_sessions_ended';
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

export interface UploadedAttachment {
  id: string;
  kind: Attachment['kind'];
  mime: string;
  label: string;
  fileName: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  viewPolicy: ViewPolicy;
  hasThumbnail: boolean;
}
