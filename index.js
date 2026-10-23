import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth");
const logger = pino({ level: "silent" });

let sock = null;
let connecting = false;
let reconnectTimer = null;
let selectedMode = "qr";
let currentQr = "";
let pairingCode = "";
let connectionStatus = "OFFLINE";
let lastError = "";

if (!ADMIN_TOKEN) {
  console.error("Configure ADMIN_TOKEN nas variáveis de ambiente.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Token inválido ou ausente." });
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/status", auth, (_req, res) => {
  res.json({ status: connectionStatus, mode: selectedMode, qr: currentQr || null,
    pairingCode: pairingCode || null, lastError: lastError || null });
});

app.post("/api/connect", auth, (req, res) => {
  if (connecting || connectionStatus === "ONLINE") {
    return res.status(409).json({ error: "O bot já está conectando ou conectado." });
  }
  const mode = req.body?.mode;
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  if (!["qr", "pairing"].includes(mode)) {
    return res.status(400).json({ error: "Escolha QR Code ou pareamento." });
  }
  if (mode === "pairing" && !/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ error: "Número inválido. Informe DDI e DDD." });
  }
  selectedMode = mode;
  currentQr = "";
  pairingCode = "";
  lastError = "";
  res.json({ ok: true, message: "Conexão iniciada. Acompanhe o painel." });
  startWhatsApp(mode, phone).catch(err => {
    lastError = err.message || "Falha na conexão";
    connectionStatus = "OFFLINE";
    connecting = false;
    console.error(lastError);
  });
});

app.post("/api/disconnect", auth, (_req, res) => {
  clearTimeout(reconnectTimer);
  const old = sock;
  sock = null;
  connecting = false;
  connectionStatus = "OFFLINE";
  currentQr = "";
  pairingCode = "";
  if (old) old.end(undefined);
  res.json({ ok: true, message: "Conexão encerrada. A sessão foi mantida." });
});

app.post("/api/logout", auth, async (_req, res) => {
  clearTimeout(reconnectTimer);
  const old = sock;
  sock = null;
  connecting = false;
  connectionStatus = "OFFLINE";
  currentQr = "";
  pairingCode = "";
  try {
    if (old) await old.logout();
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({ ok: true, message: "Sessão apagada. Faça novo pareamento." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function startWhatsApp(mode, phone) {
  if (connecting || connectionStatus === "ONLINE") return;
  connecting = true;
  connectionStatus = "CONECTANDO";
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const ws = makeWASocket({
    version, logger, auth: state, printQRInTerminal: false,
    browser: ["AnonBot", "Chrome", "1.0.0"],
    markOnlineOnConnect: false, syncFullHistory: false
  });
  sock = ws;
  ws.ev.on("creds.update", saveCreds);

  let pairRequested = false;
  ws.ev.on("connection.update", async update => {
    if (sock !== ws) return;
    const { connection, qr, lastDisconnect } = update;

    if (qr && mode === "qr") {
      try { currentQr = await QRCode.toDataURL(qr); }
      catch { lastError = "Falha ao gerar QR Code."; }
    }

    if (mode === "pairing" && !state.creds.registered && !pairRequested) {
      pairRequested = true;
      try { pairingCode = await ws.requestPairingCode(phone); }
      catch (err) { lastError = "Falha no pareamento: " + err.message; }
    }

    if (connection === "open") {
      connectionStatus = "ONLINE";
      connecting = false;
      currentQr = "";
      pairingCode = "";
      lastError = "";
      console.log("[AnonBot] WhatsApp conectado.");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      connectionStatus = "OFFLINE";
      currentQr = "";
      connecting = false;
      sock = null;
      if (code === DisconnectReason.loggedOut) {
        lastError = "Sessão encerrada. Faça novo pareamento.";
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (!sock && !connecting) {
          startWhatsApp(selectedMode, phone).catch(err => {
            lastError = err.message;
            connecting = false;
          });
        }
      }, 5000);
    }
  });

  ws.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" || sock !== ws) return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      try { await handleMessage(ws, msg); }
      catch (err) { console.error("[Mensagem]", err.message); }
    }
  });
}

function textOf(msg) {
  const m = msg.message || {};
  return m.conversation || m.extendedTextMessage?.text ||
    m.imageMessage?.caption || m.videoMessage?.caption || "";
}

async function handleMessage(ws, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;
  const text = textOf(msg).trim();
  if (!text.startsWith("+")) return;
  const [raw, ...args] = text.slice(1).trim().split(/\s+/);
  const cmd = (raw || "").toLowerCase();
  const group = jid.endsWith("@g.us");
  const reply = content => ws.sendMessage(jid, { text: content }, { quoted: msg });

  if (cmd === "ping") return reply("🏓 Pong! AnonBot está ativo.");
  if (cmd === "menu" || cmd === "help") {
    return reply("╭━━〔 ANONBOT 〕━━╮\n┃ +ping\n┃ +menu\n┃ +grupo\n┃ +ban @membro\n┃ +promover @membro\n┃ +rebaixar @membro\n╰━━━━━━━━━━━━╯");
  }
  if (cmd === "grupo") {
    if (!group) return reply("Use este comando em um grupo.");
    const meta = await ws.groupMetadata(jid);
    return reply(`👥 ${meta.subject}\nParticipantes: ${meta.participants.length}`);
  }

  const actions = { ban: "remove", kick: "remove", promover: "promote", rebaixar: "demote" };
  if (!actions[cmd]) return;
  if (!group) return reply("Este comando funciona somente em grupos.");

  const meta = await ws.groupMetadata(jid);
  const participants = meta.participants || [];
  const norm = value => (value || "").split(":")[0].split("@")[0];
  const sender = msg.key.participant || jid;
  const senderP = participants.find(p => p.id === sender || norm(p.id) === norm(sender));
  const botP = participants.find(p => p.id === ws.user?.id || norm(p.id) === norm(ws.user?.id));
  if (!senderP?.admin) return reply("⛔ Somente administradores podem usar este comando.");
  if (!botP?.admin) return reply("⛔ O bot precisa ser administrador do grupo.");

  const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const target = mentions[0] || args[0];
  if (!target) return reply("Marque o membro que deseja alterar.");
  const targetJid = target.includes("@") ? target : `${target.replace(/\D/g, "")}@s.whatsapp.net`;
  try {
    await ws.groupParticipantsUpdate(jid, [targetJid], actions[cmd]);
    return reply("✅ Solicitação de administração executada.");
  } catch {
    return reply("❌ Não foi possível executar. Confira as permissões do grupo.");
  }
}

app.listen(PORT, "0.0.0.0", () => console.log(`[AnonBot] Servidor ativo na porta ${PORT}`));
