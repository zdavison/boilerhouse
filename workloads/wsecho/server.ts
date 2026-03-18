Bun.serve({
	port: 8080,
	websocket: {
		message(ws, message) {
			ws.send(message);
		},
	},
	fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			server.upgrade(req);
			return;
		}
		if (url.pathname === "/") {
			return new Response("ok");
		}
		return new Response("Not Found", { status: 404 });
	},
});
