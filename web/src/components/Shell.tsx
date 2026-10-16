import { useEffect } from 'react';
import { LuLockKeyhole, LuSquarePen } from 'react-icons/lu';
import { match } from '../lib/router';
import { setActiveConversation, useApp } from '../state/app';
import { openNewChat } from '../state/ui';
import { Chat } from './Chat';
import { GlobalDialogs } from './dialogs';
import { MediaViewers } from './Media';
import { Rail } from './Rail';
import { Settings } from './Settings';
import { Wordmark } from './ui';

/**
 * Two panels on desktop (list + conversation). On narrow screens one panel at a time:
 * the list at "/", the open conversation or settings as a full-screen detail view.
 */
export function Shell({ path }: { path: string }) {
  const conv = match(path, '/c/:id');
  const settings = path === '/settings' || path.startsWith('/settings/');
  const detail = !!conv || settings;
  const conversationId = conv?.id ?? null;

  useEffect(() => {
    setActiveConversation(conversationId);
    return () => setActiveConversation(null);
  }, [conversationId]);

  return (
    <div className={`shell${detail ? ' shell--detail' : ''}`}>
      <Rail activeId={conversationId} />
      <main className="main">{conversationId ? <Chat key={conversationId} conversationId={conversationId} /> : settings ? <Settings path={path} /> : <Welcome />}</main>
      <GlobalDialogs />
      <MediaViewers />
    </div>
  );
}

function Welcome() {
  const me = useApp((s) => s.me);
  return (
    <div className="welcome">
      <div className="welcome__inner">
        <Wordmark size={56} />
        <h2>Welcome{me?.displayName ? `, ${me.displayName.split(' ')[0]}` : ''}</h2>
        <p>Pick a conversation on the left, or start a new one by searching for someone's username.</p>
        <button className="btn btn--primary" onClick={() => openNewChat()}>
          <LuSquarePen /> New chat
        </button>
        <span className="welcome__lock">
          <LuLockKeyhole /> Messages are end-to-end encrypted
        </span>
      </div>
    </div>
  );
}
