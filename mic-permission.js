"use strict";

// Requests microphone permission for the extension's own origin and stops the
// tracks immediately — the recording indicator must not stay lit. The
// permission then applies to the whole extension, so side-panel dictation
// works afterwards without this window.

const { micErrorMessage } = globalThis.SCRIBE_AUDIO;

const btn = document.getElementById("allow");
const status = document.getElementById("status");

function say(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  say("Requesting permission…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    say("Permission granted. You can close this window.", "ok");
    setTimeout(() => window.close(), 900);
  } catch (err) {
    btn.disabled = false;
    say(micErrorMessage(err), "err");
  }
});

btn.focus();
