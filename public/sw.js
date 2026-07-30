self.addEventListener("push", (event) => {
  const data = (() => {
    try {
      return event.data?.json() || {};
    } catch {
      return {};
    }
  })();
  event.waitUntil(
    self.registration.showNotification(data.title || "Love Tracker ♥", {
      body: data.body || "Your love answer is ready.",
      icon: "/apple-touch-icon.png",
      badge: "/apple-touch-icon.png",
      tag: data.tag || "love-answer",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    event.notification.data?.url || "/",
    self.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.navigate(target);
        return existing.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
