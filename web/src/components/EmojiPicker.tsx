import { useState } from 'react';
import { Popover } from './ui';

/** A compact, dependency-free emoji palette. The device keyboard covers everything else. */
const GROUPS: { icon: string; label: string; emoji: string }[] = [
  { icon: '😀', label: 'Smileys', emoji: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬' },
  { icon: '👋', label: 'People', emoji: '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💪 🦾 🧠 👀 👁️ 👅 👄 💋 🧑 👶 👧 🧒 👦 👩 👨 🧓 👵 👴 🙋 🙇 🤦 🤷 💃 🕺 👯 🧘' },
  { icon: '❤️', label: 'Symbols', emoji: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ✨ ⭐ 🌟 💫 🔥 💯 ✅ ☑️ ✔️ ❌ ❓ ❗ ‼️ ⚠️ 🚫 💤 💬 💭 🗯️ 🎉 🎊 🎈 🎁 🏆 🥇 🔔 🔕 🎵 🎶 ➕ ➖ ✖️ 💲 ♻️ 🆗 🆒 🆕 🔝' },
  { icon: '🌿', label: 'Nature & food', emoji: '🌸 🌹 🌺 🌻 🌼 🌷 🌱 🌿 🍀 🍁 🍂 🌴 🌵 🌊 🌙 ☀️ ⛅ 🌧️ ⛈️ ❄️ 🌈 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦋 🐢 🐍 🐬 🐳 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🥭 🍍 🥥 🥑 🍅 🌶️ 🌽 🥕 🍞 🧀 🍳 🍕 🍔 🍟 🌮 🍜 🍛 🍚 🍰 🎂 🍫 🍩 ☕ 🍵 🧋 🥤 🍺 🥂' },
  { icon: '✈️', label: 'Travel & things', emoji: '🚗 🚕 🚌 🚲 🛵 🚆 ✈️ 🚀 🚢 🏠 🏡 🏢 🏫 🏥 🏖️ 🏔️ 🗺️ 📍 ⏰ ⌛ 📱 💻 ⌨️ 🖥️ 📷 🎥 📺 🎧 🎮 📚 📖 ✏️ 📝 📎 📌 🔒 🔓 🔑 💡 💰 💳 🎓 💼 🛒 🎨 ⚽ 🏏 🏀 🏸 🎾 🏓' },
];

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export function EmojiPicker({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (e: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState(0);
  const group = GROUPS[tab]!;
  return (
    <Popover anchor={anchor} onClose={onClose} className="emoji-panel" placement="above">
      <div className="emoji-panel__tabs" role="tablist" aria-label="Emoji categories">
        {GROUPS.map((g, i) => (
          <button key={g.label} type="button" role="tab" aria-selected={i === tab} aria-label={g.label} onClick={() => setTab(i)}>
            {g.icon}
          </button>
        ))}
      </div>
      <div className="emoji-panel__grid" role="tabpanel" aria-label={group.label}>
        {group.emoji.split(' ').map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} aria-label={e}>
            {e}
          </button>
        ))}
      </div>
    </Popover>
  );
}
