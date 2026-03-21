import { defineWorkload } from "@boilerhouse/core";

// Same inline Python WS echo server as the podman fixture.
const serverScript = `
import asyncio, hashlib, base64, struct
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass

MAGIC = b"258EAFA5-E914-47DA-95CA-5AB9EE563BEE"

def accept_key(k):
    return base64.b64encode(hashlib.sha1(k.encode() + MAGIC).digest()).decode()

def frame(op, data):
    f = bytearray([0x80 | op])
    n = len(data)
    if n < 126: f.append(n)
    elif n < 65536: f.append(126); f.extend(struct.pack("!H", n))
    else: f.append(127); f.extend(struct.pack("!Q", n))
    f.extend(data)
    return bytes(f)

async def read_frame(r):
    h = await r.readexactly(2)
    op, ln = h[0] & 0xF, h[1] & 0x7F
    masked = bool(h[1] & 0x80)
    if ln == 126: ln = struct.unpack("!H", await r.readexactly(2))[0]
    elif ln == 127: ln = struct.unpack("!Q", await r.readexactly(8))[0]
    if masked:
        mask = await r.readexactly(4)
        d = bytearray(await r.readexactly(ln))
        for i in range(ln): d[i] ^= mask[i % 4]
        return op, bytes(d)
    return op, await r.readexactly(ln)

async def handle(r, w):
    req = b""
    while b"\\r\\n\\r\\n" not in req:
        c = await r.read(4096)
        if not c: w.close(); return
        req += c
    hd = {}
    lines = req.decode().split("\\r\\n")
    path = lines[0].split(" ")[1]
    for l in lines[1:]:
        if ": " in l:
            k, v = l.split(": ", 1); hd[k.lower()] = v
    if path != "/ws" or hd.get("upgrade", "").lower() != "websocket":
        w.write(b"HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\n\\r\\n")
        await w.drain(); w.close(); return
    ak = accept_key(hd.get("sec-websocket-key", ""))
    w.write(f"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: {ak}\\r\\n\\r\\n".encode())
    await w.drain()
    try:
        while True:
            op, d = await read_frame(r)
            if op == 8: w.write(frame(8, b"")); await w.drain(); break
            if op in (1, 2): w.write(frame(op, d)); await w.drain()
    except: pass
    finally: w.close()

async def main():
    Thread(target=lambda: HTTPServer(("0.0.0.0", 8080), Health).serve_forever(), daemon=True).start()
    srv = await asyncio.start_server(handle, "0.0.0.0", 8081)
    async with srv: await srv.serve_forever()

asyncio.run(main())
`;

export default defineWorkload({
	name: "e2e-wsecho",
	version: "1.0.0",
	image: { ref: "docker.io/library/python:3-alpine" },
	resources: { vcpus: 1, memory_mb: 256 },
	network: {
		access: "outbound",
		expose: [
			{ guest: 8080, host_range: [0, 0] },
			{ guest: 8081, host_range: [0, 0] },
		],
		websocket: "/ws",
	},
	idle: { timeout_seconds: 300, action: "hibernate" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 30,
		http_get: { path: "/", port: 8080 },
	},
	entrypoint: {
		cmd: "python3",
		args: ["-c", serverScript.trim()],
	},
	metadata: { description: "Python WebSocket echo server for K8s E2E testing" },
});
