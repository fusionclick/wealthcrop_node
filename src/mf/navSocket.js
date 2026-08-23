const { Server } = require("socket.io");

function mapNavRows(lists = []) {
  const navs = {};
  for (const row of lists) {
    const nav = Number(row.nav ?? row.nav_value);
    if (!Number.isFinite(nav)) continue;
    const isin = row.isin || row.scheme_isin;
    const code = row.bse_scheme_code || row.scheme_bse_code;
    if (isin) navs[String(isin).toUpperCase()] = nav;
    if (code) navs[String(code).toUpperCase()] = nav;
  }
  return navs;
}

function attachNavSocket(httpServer, controller) {
  const io = new Server(httpServer, {
    path: "/api/socket.io",
    cors: { origin: true },
  });
  let latest = { at: 0, navs: {} };
  const tickMs = Number(process.env.NAV_SOCKET_MS) || 60_000;

  async function tick() {
    try {
      if (!controller.accessToken) await controller.loginFunc();
      const today = controller.formatDate(new Date());
      const response = await controller.navService.getNavMasterList(controller.accessToken, {
        data: {
          fields: ["ALL"],
          count_only: false,
          start: 0,
          length: 200,
          filter_param: { nav_date: today },
        },
      });
      const navs = mapNavRows(response?.data?.lists || []);
      if (!Object.keys(navs).length) return;
      latest = { at: Date.now(), navs };
      io.emit("nav_update", latest);
    } catch (err) {
      console.error("[nav-socket]", err.message);
    }
  }

  io.on("connection", (socket) => {
    if (latest.at) socket.emit("nav_update", latest);
  });

  tick();
  setInterval(tick, tickMs);
  return io;
}

module.exports = { attachNavSocket, mapNavRows };
