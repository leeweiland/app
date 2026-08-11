// sw.js — service worker for PRA Chat push notifications. Registered from
// chat.html's setupPush() at /chat-app/sw.js, which scopes it to
// /chat-app/* (a service worker's default max scope is its own directory).
// Without a registered service worker on this origin, the Push API has
// nothing to deliver a push event to or call showNotification() from — the
// subscription flow can "succeed" (permission granted) while no
// notification ever actually appears.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = { title: 'New message', body: '', conversationId: '' };
  try { data = { ...data, ...e.data.json() }; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { conversationId: data.conversationId },
      tag: data.conversationId || undefined,
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const convoId = e.notification.data?.conversationId;
  const url = convoId ? `/chat-app/chat.html?convo=${convoId}` : '/chat-app/chat.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const existing = clients.find((c) => c.url.includes('/chat-app/chat.html'));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
