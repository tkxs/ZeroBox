import "./mobile.css";

const GATEWAY_URL_STORAGE_KEY = "zerobox.mobile.gatewayUrl";
const configuredWebUrl = __ZEROAGENT_ANDROID_WEB_URL__.trim();
const form = document.querySelector<HTMLFormElement>("#gateway-form");
const input = document.querySelector<HTMLInputElement>("#gateway-url");
const status = document.querySelector<HTMLElement>("#status");

function normalizeGatewayUrl(rawValue: string): string {
  let value = rawValue.trim();
  if (!value) throw new Error("Enter the ZeroAgent WebUI URL");
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;

  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || !url.hostname) {
    throw new Error("The WebUI URL must use HTTP or HTTPS");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function openWebUi(value: string) {
  window.location.replace(normalizeGatewayUrl(value));
}

if (configuredWebUrl) {
  openWebUi(configuredWebUrl);
} else if (form && input && status) {
  status.textContent = "Enter the deployed ZeroAgent WebUI URL";
  form.hidden = false;
  try {
    input.value = localStorage.getItem(GATEWAY_URL_STORAGE_KEY) ?? "";
  } catch {
    // Navigation remains available when WebView storage is disabled.
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const url = normalizeGatewayUrl(input.value);
      localStorage.setItem(GATEWAY_URL_STORAGE_KEY, url);
      openWebUi(url);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Unable to open the ZeroAgent WebUI";
      input.focus();
    }
  });
}
