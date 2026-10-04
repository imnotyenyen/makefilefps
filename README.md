# YOUNJ Config Worker

Cloudflare Worker cung cấp config (password + maintenance) cho YOUNJ Plist Editor.

## Endpoints

- `GET /config` → trả maintenance + meta (không có password)
- `POST /auth` → `{ password }` → `{ ok, token? }`
- `POST /verify` → `{ token }` → `{ valid }`

## Deploy

### 1. Push repo lên GitHub (private)

### 2. Connect Cloudflare

- Vào [dash.cloudflare.com](https://dash.cloudflare.com)
- Workers & Pages → Create → **Connect to Git**
- Chọn repo `younj-config`
- Build command: (để trống)
- Deploy command: `npx wrangler deploy`
- Deploy

### 3. Set secret TOKEN_SECRET

- Worker → Settings → Variables and Secrets
- Thêm secret `TOKEN_SECRET` = chuỗi random ≥ 32 ký tự
  (VD: `younj_a8f9K2mP4xQ7nR3vB6wT1sD5hJ0gL9cZ`)

### 4. (Khuyến nghị) Tạo KV cho rate limit

- Cloudflare Dashboard → Storage & Databases → KV → Create namespace `younj-rate-limit`
- Copy ID → dán vào `wrangler.toml` (bỏ comment dòng `[[kv_namespaces]]`)
- Commit → push → auto redeploy

### 5. Lấy URL Worker

VD: `https://younj-config.abcxyz.workers.dev`

Dán URL này vào `index.html`:
\`\`\`js
const WORKER_URL = 'https://younj-config.abcxyz.workers.dev';
\`\`\`

## Update password / maintenance

- Sửa `src/config.json` → commit → push
- Cloudflare auto redeploy sau ~1-2 phút
