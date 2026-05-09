const UUID = (Deno.env.get("UUID") || "").trim().toLowerCase();
const NAME = Deno.env.get("NAME") || "deno-vless";
const DEFAULT_HOST = Deno.env.get("HOST") || "";
const IS_DENO_DEPLOY = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));

if (!UUID || !isValidUUID(UUID)) {
  console.warn("Please set a valid UUID env var before using the proxy.");
}

Deno.serve(IS_DENO_DEPLOY ? handleRequest : { port: Number(Deno.env.get("PORT") || "8000") }, handleRequest);

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("host") || DEFAULT_HOST;

    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      if (typeof Deno.connect !== "function") {
        return text("This runtime does not support outbound TCP sockets.", 501);
      }

      return handleVlessWebSocket(request);
    }

    if (url.pathname === "/") {
      return text(`Deno VLESS over WebSocket is running.\nSubscription: https://${host}/${UUID}\n`);
    }

    if (url.pathname.toLowerCase() === `/${UUID}`) {
      const body = buildSubscription(UUID, host, url);
      const asBase64 = url.searchParams.has("base64") || url.searchParams.has("b64");

      return new Response(asBase64 ? btoa(body) : body, {
        headers: {
          "content-type": "text/plain;charset=utf-8",
          "profile-update-interval": "24",
        },
      });
    }

    return text("Not found", 404);
  } catch (error) {
    return text(error?.stack || String(error), 500);
  }
}

function handleVlessWebSocket(request) {
  const { socket, response } = Deno.upgradeWebSocket(request);
  let remote = null;
  let remoteWriter = null;
  let firstPacket = true;
  let writeQueue = Promise.resolve();

  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    const earlyData = request.headers.get("sec-websocket-protocol") || "";
    if (earlyData) {
      const data = base64UrlToUint8Array(earlyData);
      if (data?.byteLength) {
        handleClientChunk(data, socket, true).catch(() => safeClose(socket));
      }
    }
  };

  socket.onmessage = (event) => {
    writeQueue = writeQueue
      .then(() => handleClientChunk(toUint8Array(event.data), socket, firstPacket))
      .then(() => {
        firstPacket = false;
      })
      .catch((error) => {
        console.error("websocket message error:", error);
        cleanup();
      });
  };

  socket.onclose = cleanup;
  socket.onerror = cleanup;

  async function handleClientChunk(chunk, ws, isFirstPacket) {
    if (!chunk?.byteLength) return;

    if (!isFirstPacket) {
      if (!remoteWriter) throw new Error("remote socket is not ready");
      await remoteWriter.write(chunk);
      return;
    }

    const header = parseVlessHeader(chunk, UUID);
    if (header.hasError) throw new Error(header.message);
    if (header.isUdp) throw new Error("UDP is not supported in this minimal version");

    remote = await Deno.connect({ hostname: header.address, port: header.port });
    remoteWriter = remote.writable.getWriter();

    const rawClientData = chunk.slice(header.rawDataIndex);
    if (rawClientData.byteLength > 0) {
      await remoteWriter.write(rawClientData);
    }

    pipeRemoteToWebSocket(remote, ws, new Uint8Array([header.version, 0])).catch((error) => {
      console.error("remote pipe error:", error);
      cleanup();
    });
  }

  function cleanup() {
    try {
      remoteWriter?.releaseLock();
    } catch (_) {
      // ignore
    }
    try {
      remote?.close();
    } catch (_) {
      // ignore
    }
    safeClose(socket);
  }

  return response;
}

async function pipeRemoteToWebSocket(conn, ws, responseHeader) {
  let firstChunk = true;

  for await (const chunk of conn.readable) {
    if (ws.readyState !== WebSocket.OPEN) break;

    if (firstChunk) {
      const merged = new Uint8Array(responseHeader.byteLength + chunk.byteLength);
      merged.set(responseHeader, 0);
      merged.set(chunk, responseHeader.byteLength);
      ws.send(merged);
      firstChunk = false;
    } else {
      ws.send(chunk);
    }
  }

  safeClose(ws);
}

function parseVlessHeader(buffer, expectedUUID) {
  if (buffer.byteLength < 24) {
    return { hasError: true, message: "invalid VLESS packet" };
  }

  const version = buffer[0];
  const receivedUUID = stringifyUUID(buffer.slice(1, 17));

  if (receivedUUID !== expectedUUID.toLowerCase()) {
    return { hasError: true, message: "invalid UUID" };
  }

  const optLength = buffer[17];
  const commandIndex = 18 + optLength;
  const command = buffer[commandIndex];
  const isTcp = command === 1;
  const isUdp = command === 2;

  if (!isTcp && !isUdp) {
    return { hasError: true, message: `unsupported command: ${command}` };
  }

  const portIndex = commandIndex + 1;
  const port = new DataView(buffer.buffer, buffer.byteOffset + portIndex, 2).getUint16(0);
  const addressTypeIndex = portIndex + 2;
  const addressType = buffer[addressTypeIndex];
  let addressIndex = addressTypeIndex + 1;
  let address = "";

  if (addressType === 1) {
    address = Array.from(buffer.slice(addressIndex, addressIndex + 4)).join(".");
    addressIndex += 4;
  } else if (addressType === 2) {
    const length = buffer[addressIndex];
    addressIndex += 1;
    address = new TextDecoder().decode(buffer.slice(addressIndex, addressIndex + length));
    addressIndex += length;
  } else if (addressType === 3) {
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(new DataView(buffer.buffer, buffer.byteOffset + addressIndex + i * 2, 2).getUint16(0).toString(16));
    }
    address = parts.join(":");
    addressIndex += 16;
  } else {
    return { hasError: true, message: `unsupported address type: ${addressType}` };
  }

  if (!address || !port) {
    return { hasError: true, message: "empty target address or port" };
  }

  return {
    hasError: false,
    version,
    isUdp,
    address,
    port,
    rawDataIndex: addressIndex,
  };
}

function buildSubscription(uuid, host, url) {
  const tls = url.searchParams.get("security") || "tls";
  const port = url.searchParams.get("port") || (tls === "tls" ? "443" : "80");
  const path = url.searchParams.get("path") || "/";
  const nodeName = encodeURIComponent(NAME);
  const encodedPath = encodeURIComponent(path);
  const encodedHost = encodeURIComponent(host);

  return `vless://${uuid}@${host}:${port}?encryption=none&security=${tls}&type=ws&host=${encodedHost}&path=${encodedPath}#${nodeName}`;
}

function stringifyUUID(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function isValidUUID(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(data);
}

function base64UrlToUint8Array(value) {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch (_) {
    return undefined;
  }
}

function safeClose(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch (_) {
    // ignore
  }
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8" },
  });
}
