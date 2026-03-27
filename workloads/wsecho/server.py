"""WebSocket echo server on :8080/ws with HTTP health check on :8081."""

import asyncio
import hashlib
import base64
import struct
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, format, *args):
        pass


WS_MAGIC = b"258EAFA5-E914-47DA-95CA-5AB9EE563BEE"


def ws_accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1(key.encode() + WS_MAGIC).digest()).decode()


def make_frame(opcode: int, data: bytes) -> bytes:
    frame = bytearray([0x80 | opcode])
    length = len(data)
    if length < 126:
        frame.append(length)
    elif length < 65536:
        frame.append(126)
        frame.extend(struct.pack("!H", length))
    else:
        frame.append(127)
        frame.extend(struct.pack("!Q", length))
    frame.extend(data)
    return bytes(frame)


async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    head = await reader.readexactly(2)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F

    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]

    if masked:
        mask = await reader.readexactly(4)
        data = bytearray(await reader.readexactly(length))
        for i in range(length):
            data[i] ^= mask[i % 4]
        return opcode, bytes(data)

    return opcode, await reader.readexactly(length)


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    # Read HTTP upgrade request
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = await reader.read(4096)
        if not chunk:
            writer.close()
            return
        request += chunk

    headers = {}
    lines = request.decode().split("\r\n")
    path = lines[0].split(" ")[1] if lines else "/"
    for line in lines[1:]:
        if ": " in line:
            key, val = line.split(": ", 1)
            headers[key.lower()] = val

    if path != "/ws" or headers.get("upgrade", "").lower() != "websocket":
        writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()
        return

    # WebSocket handshake
    accept = ws_accept_key(headers.get("sec-websocket-key", ""))
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    )
    writer.write(response.encode())
    await writer.drain()

    # Echo loop
    try:
        while True:
            opcode, data = await read_frame(reader)
            if opcode == 0x8:  # close
                writer.write(make_frame(0x8, b""))
                await writer.drain()
                break
            if opcode in (0x1, 0x2):  # text or binary
                writer.write(make_frame(opcode, data))
                await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        writer.close()


async def main():
    Thread(
        target=lambda: HTTPServer(("0.0.0.0", 8081), HealthHandler).serve_forever(),
        daemon=True,
    ).start()

    server = await asyncio.start_server(handle_client, "0.0.0.0", 8080)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
