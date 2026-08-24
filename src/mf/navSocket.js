const { Server } = require("socket.io");
const { getNavs, mapNavRows } = require("./navStore");

function attachNavSocket(httpServer, controller) {
  const io = new Server(httpServer, {
    path: "/api/socket.io",
    cors: { origin: true },
  });
  let latest = { at: 0, navs: {} };
  const tickMs = Number(process.env.NAV_SOCKET_MS) || 60_000;

  async function tick() {
    const snap = await getNavs(controller);
    if (!Object.keys(snap.navs).length || snap.at === latest.at) return;
    latest = { at: snap.at, date: snap.date, navs: snap.navs };
    io.emit("nav_update", latest);
  }

  io.on("connection", (socket) => {
    if (latest.at) socket.emit("nav_update", latest);
  });

  tick();
  setInterval(tick, tickMs);
  return io;
}

module.exports = { attachNavSocket, mapNavRows };
