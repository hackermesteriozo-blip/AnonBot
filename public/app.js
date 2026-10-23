const $ = id => document.getElementById(id);
let token = "";
let mode = "qr";
let poll = null;
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    ...(options.headers || {})
  }});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
  return data;
}
function notice(text, error = false) {
  $("notice").textContent = text || "";
  $("notice").style.color = error ? "#ff8496" : "#6ae5dc";
}
function setMode(next) {
  mode = next;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("phoneWrap").classList.toggle("hidden", mode !== "pairing");
  $("help").textContent = mode === "qr"
    ? "No WhatsApp, abra Dispositivos conectados → Conectar dispositivo e escaneie o QR."
    : "Digite o número da conta que você controla, com DDI e DDD, somente números.";
  $("qrBox").classList.add("hidden");
  $("codeBox").classList.add("hidden");
}
async function refresh() {
  try {
    const d = await api("/api/status");
    $("status").textContent = d.status;
    $("stat").textContent = d.status;
    $("method").textContent = d.mode === "pairing" ? "Pareamento" : "QR Code";
    $("badge").classList.toggle("online", d.status === "ONLINE");
    $("error").textContent = d.lastError || "";
    if (d.qr && d.status !== "ONLINE") {
      $("qr").src = d.qr;
      $("qrBox").classList.remove("hidden");
    } else $("qrBox").classList.add("hidden");
    if (d.pairingCode && d.status !== "ONLINE") {
      $("code").textContent = d.pairingCode;
      $("codeBox").classList.remove("hidden");
    } else $("codeBox").classList.add("hidden");
    if (d.status === "ONLINE") notice("WhatsApp conectado e pronto para receber comandos.");
  } catch (e) { notice(e.message, true); }
}
$("login").onclick = async () => {
  token = $("token").value.trim();
  if (!token) return notice("Digite o token configurado no Render.", true);
  try {
    await api("/api/status");
    $("controls").classList.remove("hidden");
    $("monitor").classList.remove("hidden");
    $("login").textContent = "Autenticado ✓";
    notice("Acesso autorizado.");
    await refresh();
    clearInterval(poll);
    poll = setInterval(refresh, 3000);
  } catch (e) { token = ""; notice(e.message, true); }
};
document.querySelectorAll(".tab").forEach(b => b.onclick = () => setMode(b.dataset.mode));
$("connect").onclick = async () => {
  try {
    notice("Solicitando conexão...");
    await api("/api/connect", { method: "POST", body: JSON.stringify({ mode, phone: $("phone").value }) });
    notice("Solicitação recebida. Aguarde o código ou QR.");
    await refresh();
  } catch (e) { notice(e.message, true); }
};
$("refresh").onclick = refresh;
$("disconnect").onclick = async () => {
  if (!confirm("Desconectar mantendo a sessão salva?")) return;
  try { const d = await api("/api/disconnect", { method: "POST", body: "{}" }); notice(d.message); await refresh(); }
  catch (e) { notice(e.message, true); }
};
$("logout").onclick = async () => {
  if (!confirm("Apagar as credenciais salvas? Será necessário vincular novamente.")) return;
  try { const d = await api("/api/logout", { method: "POST", body: "{}" }); notice(d.message); await refresh(); }
  catch (e) { notice(e.message, true); }
};
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("code").textContent); notice("Código copiado."); }
  catch { notice("Não foi possível copiar automaticamente.", true); }
};
setMode("qr");