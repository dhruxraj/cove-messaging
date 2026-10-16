import { navigate } from '../lib/router';
import { createStore } from '../lib/store';
import type { Message, PublicProfile } from '../lib/types';

/** Transient UI state shared across components (open dialogs, jump targets). */
export const ui = createStore<{
  newChat: { open: boolean; user: PublicProfile | null };
  forward: Message | null;
  report: { userId: string; message: Message | null } | null;
  jump: { conversationId: string; messageId: string; nonce: number } | null;
}>({ newChat: { open: false, user: null }, forward: null, report: null, jump: null });

export const useUi = ui.useStore;
export const openNewChat = (user: PublicProfile | null = null) => ui.set({ newChat: { open: true, user } });
export const closeNewChat = () => ui.set({ newChat: { open: false, user: null } });

let nonce = 0;
/** Open a conversation scrolled to (and highlighting) a specific message. */
export function jumpTo(conversationId: string, messageId: string) {
  ui.set({ jump: { conversationId, messageId, nonce: ++nonce } });
  navigate(`/c/${conversationId}`);
}
