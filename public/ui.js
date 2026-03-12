const presets = {
  blank: {
    body: "",
    headers: '{\n  "Accept": "application/json"\n}',
    method: "GET",
    url: "",
  },
  "public-read": {
    body: "",
    headers: '{\n  "Accept": "application/json"\n}',
    method: "GET",
    url: "https://jsonplaceholder.typicode.com/todos/1",
  },
  "public-write": {
    body: '{\n  "title": "proxy demo",\n  "completed": false,\n  "userId": 12\n}',
    headers: '{\n  "Accept": "application/json",\n  "Content-Type": "application/json"\n}',
    method: "POST",
    url: "https://postman-echo.com/post",
  },
};

const elements = {
  body: document.getElementById("body"),
  bodyField: document.getElementById("bodyField"),
  copyButton: document.getElementById("copyButton"),
  durationValue: document.getElementById("durationValue"),
  form: document.getElementById("requestForm"),
  formMessage: document.getElementById("formMessage"),
  headers: document.getElementById("headers"),
  method: document.getElementById("method"),
  policyGrid: document.getElementById("policyGrid"),
  policyNote: document.getElementById("policyNote"),
  resetButton: document.getElementById("resetButton"),
  responseBody: document.getElementById("responseBody"),
  responseHeaders: document.getElementById("responseHeaders"),
  sendButton: document.getElementById("sendButton"),
  sizeValue: document.getElementById("sizeValue"),
  statusValue: document.getElementById("statusValue"),
  typeValue: document.getElementById("typeValue"),
  url: document.getElementById("url"),
};

let lastResponseText = "";

function formatBytes(size) {
  if (!size) return "0 B";

  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function setFormMessage(text, tone = "") {
  elements.formMessage.textContent = text;
  if (tone) {
    elements.formMessage.dataset.tone = tone;
    return;
  }

  delete elements.formMessage.dataset.tone;
}

function updateBodyState() {
  const hasBody = elements.method.value !== "GET";
  elements.body.disabled = !hasBody;
  elements.bodyField.style.opacity = hasBody ? "1" : "0.58";

  if (!hasBody) {
    elements.body.placeholder = "GET requests are sent without a body.";
    return;
  }

  elements.body.placeholder = '{\n  "key": "value"\n}';
}

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;

  elements.url.value = preset.url;
  elements.method.value = preset.method;
  elements.headers.value = preset.headers;
  elements.body.value = preset.body;
  updateBodyState();
  setFormMessage("Preset loaded.", "success");
}

function parseJsonObject(value, label, allowEmpty = false) {
  const trimmed = value.trim();

  if (!trimmed) {
    return allowEmpty ? {} : null;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} must be valid JSON.`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed;
}

function parseJsonBody(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch (error) {
    throw new Error("Body must be valid JSON.");
  }
}

function renderResponseMeta(response, duration, rawText) {
  const contentType = response.headers.get("content-type") || "n/a";

  elements.statusValue.textContent = `${response.status} ${response.ok ? "OK" : "Error"}`;
  elements.durationValue.textContent = `${duration} ms`;
  elements.typeValue.textContent = contentType;
  elements.sizeValue.textContent = formatBytes(new TextEncoder().encode(rawText).length);
}

function renderResponseBody(rawText, response) {
  const contentType = response.headers.get("content-type") || "";
  const shouldFormatJson =
    contentType.includes("application/json") ||
    rawText.trim().startsWith("{") ||
    rawText.trim().startsWith("[");

  if (shouldFormatJson) {
    try {
      elements.responseBody.textContent = JSON.stringify(JSON.parse(rawText), null, 2);
      return;
    } catch (error) {
      elements.responseBody.textContent = rawText;
      return;
    }
  }

  elements.responseBody.textContent = rawText || "(empty response body)";
}

function renderHeaders(response) {
  const headers = Object.fromEntries(response.headers.entries());
  elements.responseHeaders.textContent = JSON.stringify(headers, null, 2);
}

function renderPolicy(config) {
  const hostMode = config.hostAllowlist.length
    ? `${config.hostAllowlist.length} rule${config.hostAllowlist.length > 1 ? "s" : ""}`
    : "Public hosts";

  elements.policyGrid.innerHTML = [
    {
      label: "CORS",
      value: config.corsMode === "allowlist" ? "Allowlist" : "Same origin",
    },
    {
      label: "Private Nets",
      value: config.allowPrivateNetworks ? "Allowed" : "Blocked",
    },
    {
      label: "Allowed Hosts",
      value: hostMode,
    },
    {
      label: "Timeout",
      value: `${config.timeoutMs} ms`,
    },
  ]
    .map(
      (item) => `
        <article class="policy-pill">
          <span class="policy-label">${item.label}</span>
          <strong class="policy-value">${item.value}</strong>
        </article>
      `
    )
    .join("");

  const notes = [];
  if (config.hostAllowlist.length) {
    notes.push(`Host allowlist: ${config.hostAllowlist.join(", ")}`);
  } else {
    notes.push("No host allowlist configured. Public hosts are allowed.");
  }

  notes.push(
    config.allowPrivateNetworks
      ? "Private targets are enabled for this server."
      : "Private targets are blocked by default."
  );

  elements.policyNote.textContent = notes.join(" ");
}

async function loadPolicy() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Could not load config.");
    const config = await response.json();
    renderPolicy(config);
  } catch (error) {
    elements.policyNote.textContent =
      "Could not load runtime policy. The proxy still works, but the guardrail summary is unavailable.";
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  setFormMessage("");

  const url = elements.url.value.trim();
  if (!url) {
    setFormMessage("Target URL is required.", "error");
    elements.url.focus();
    return;
  }

  const method = elements.method.value;

  let headers;
  try {
    headers = parseJsonObject(elements.headers.value, "Headers", true);
  } catch (error) {
    setFormMessage(error.message, "error");
    elements.headers.focus();
    return;
  }

  let body = "";
  if (method !== "GET") {
    try {
      body = parseJsonBody(elements.body.value);
    } catch (error) {
      setFormMessage(error.message, "error");
      elements.body.focus();
      return;
    }
  }

  if (body && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  elements.sendButton.disabled = true;
  elements.sendButton.textContent = "Sending...";
  setFormMessage("Request in flight.", "success");

  const startedAt = performance.now();

  try {
    const response = await fetch(`/proxy?url=${encodeURIComponent(url)}`, {
      body: method === "GET" || !body ? undefined : body,
      headers,
      method,
    });

    const rawText = await response.text();
    const duration = Math.round(performance.now() - startedAt);
    lastResponseText = rawText;
    elements.copyButton.disabled = false;

    renderResponseMeta(response, duration, rawText);
    renderResponseBody(rawText, response);
    renderHeaders(response);

    setFormMessage(
      response.ok ? "Request completed." : "Upstream returned a non-2xx response.",
      response.ok ? "success" : "error"
    );
  } catch (error) {
    elements.statusValue.textContent = "Failed";
    elements.durationValue.textContent = `${Math.round(performance.now() - startedAt)} ms`;
    elements.typeValue.textContent = "n/a";
    elements.sizeValue.textContent = "0 B";
    elements.responseBody.textContent = error.message;
    elements.responseHeaders.textContent = "No response headers available.";
    elements.copyButton.disabled = true;
    lastResponseText = "";
    setFormMessage("Request failed before the proxy returned a response.", "error");
  } finally {
    elements.sendButton.disabled = false;
    elements.sendButton.textContent = "Send Request";
  }
}

async function copyResponse() {
  if (!lastResponseText) return;

  try {
    await navigator.clipboard.writeText(lastResponseText);
    setFormMessage("Response copied to clipboard.", "success");
  } catch (error) {
    setFormMessage("Clipboard access was denied.", "error");
  }
}

function resetForm() {
  applyPreset("blank");
  elements.responseBody.textContent = "Send a request to see the upstream response.";
  elements.responseHeaders.textContent = "No response headers yet.";
  elements.statusValue.textContent = "Idle";
  elements.durationValue.textContent = "0 ms";
  elements.typeValue.textContent = "n/a";
  elements.sizeValue.textContent = "0 B";
  elements.copyButton.disabled = true;
  lastResponseText = "";
}

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => applyPreset(button.dataset.preset));
});

elements.method.addEventListener("change", updateBodyState);
elements.form.addEventListener("submit", handleSubmit);
elements.copyButton.addEventListener("click", copyResponse);
elements.resetButton.addEventListener("click", resetForm);

applyPreset("blank");
loadPolicy();
