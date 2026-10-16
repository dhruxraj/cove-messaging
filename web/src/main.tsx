import { createRoot } from 'react-dom/client';
import './styles/app.css';
import './styles/components.css';
import { App } from './App';
import { applyTheme } from './lib/theme';
import { bootstrap } from './state/app';

applyTheme();

// Keep the app (and the message composer) inside the visible area when the on-screen keyboard opens.
// Chrome on Android resizes the layout itself (interactive-widget=resizes-content); iOS Safari only
// shrinks the visual viewport, so the app height follows it explicitly.
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    if (vv.offsetTop > 0 && document.activeElement?.tagName === 'TEXTAREA') window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}
createRoot(document.getElementById('root')!).render(<App />);
void bootstrap();

// The service worker only handles push notifications; it never caches messages or media.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}));
}
