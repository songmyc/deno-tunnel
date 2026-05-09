# Deno VLESS over WebSocket

Minimal VLESS over WebSocket server with a plain subscription endpoint.

## Features

- VLESS over WebSocket TCP forwarding
- Plain VLESS subscription link at `/<UUID>`
- Optional Base64 subscription with `?base64` or `?b64`
- 0-RTT early data from `sec-websocket-protocol`

This minimal version does not include UDP, SOCKS5 relay, KV editing, Telegram notification, dynamic UUID, Clash conversion, or preferred IP pools.

## Run Locally

```bash
deno run --allow-net --allow-env server.js
```

Required environment variable:

```bash
UUID=xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
```

Optional environment variables:

```bash
PORT=8000
NAME=deno-vless
HOST=example.com
```

PowerShell example:

```powershell
$env:UUID="xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"; deno run --allow-net --allow-env server.js
```

## Endpoints

- `/` shows a basic health message.
- `/<UUID>` returns a VLESS link.
- `/<UUID>?base64` returns the same link encoded with Base64.
- WebSocket upgrade requests are handled as VLESS over WebSocket connections.

## Client Settings

- Protocol: `vless`
- Transport: `ws`
- Path: `/`
- TLS: enabled when deployed behind HTTPS
- UUID: same as the `UUID` environment variable

Subscription URL:

```text
https://your-domain.example/<UUID>
```

Manual node format:

```text
vless://<UUID>@your-domain.example:443?encryption=none&security=tls&type=ws&host=your-domain.example&path=%2F#deno-vless
```

## Deploy To Deno Deploy

This project is intended for Deno Deploy / Deno Subhosting style deployments such as `console.deno.com`.

1. Create a new project in Deno Deploy.
2. Upload or connect this repository with `server.js` as the entrypoint.
3. Add environment variables in the project settings:

```text
UUID=xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
NAME=deno-vless
```

4. Deploy and open:

```text
https://your-project.deno.dev/<UUID>
```

Deno Deploy automatically provides the HTTPS port, so the code does not bind `PORT` there. Local runs still use `PORT` or `8000`.

Important: VLESS proxy forwarding requires outbound TCP socket support. If the Deno Deploy project/runtime does not expose `Deno.connect`, only the subscription endpoint will work and WebSocket proxy requests will return `501`.
