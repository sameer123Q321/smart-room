// Shared by the dashboard and the "Add face" page: sends requests that need the PIN.
// The browser asks for the PIN once and remembers it after it was right.

const PIN_REQUIRED = document.body.dataset.pinRequired === "true";

function savedPin() {
  try { return localStorage.getItem("doorPin") || ""; } catch (e) { return ""; }
}
function savePin(pin) {
  try { pin ? localStorage.setItem("doorPin", pin) : localStorage.removeItem("doorPin"); } catch (e) {}
}

// Shows the PIN box. Resolves with the PIN, or null when cancelled.
function askPin() {
  if (typeof HTMLDialogElement !== "function") {
    return Promise.resolve(prompt("Enter the PIN") || null);
  }

  let dlg = document.getElementById("pinDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "pinDialog";
    dlg.className = "pin-dialog";
    dlg.innerHTML =
      '<div class="pin-title">Enter PIN</div>' +
      '<p class="muted-small">Needed to open the door and to change faces</p>' +
      '<input class="input pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="PIN">' +
      '<div class="pin-actions">' +
      '  <button type="button" class="btn btn-secondary" data-close="">Cancel</button>' +
      '  <button type="button" class="btn" data-close="ok">OK</button>' +
      '</div>';
    document.body.appendChild(dlg);

    const input = dlg.querySelector("input");
    dlg.querySelectorAll("[data-close]").forEach((b) => {
      b.addEventListener("click", () => dlg.close(b.dataset.close));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        dlg.close("ok");
      }
    });
  }

  const input = dlg.querySelector("input");
  input.value = "";
  dlg.returnValue = "";

  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      resolve(dlg.returnValue === "ok" && input.value ? input.value : null);
    }, { once: true });
    dlg.showModal();
    input.focus();
  });
}

// Returns { ok, status, data }, or null when the person cancelled the PIN box.
// Throws when the server can't be reached.
async function sendWithPin(url, body, method = "POST") {
  let pin = "";
  if (PIN_REQUIRED) {
    pin = savedPin() || (await askPin()) || "";
    if (!pin) return null;
  }

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, pin })
  });
  const data = await res.json().catch(() => ({}));

  if (res.ok) savePin(pin);
  else if (res.status === 401) savePin("");
  return { ok: res.ok, status: res.status, data };
}
