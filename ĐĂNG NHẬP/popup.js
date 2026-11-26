const dataBox = document.getElementById("dataBox");
const statusEl = document.getElementById("status");
const formatMode = document.getElementById("formatMode");
const optCookie = document.getElementById("optCookie");
const optLocal = document.getElementById("optLocal");
const optSession = document.getElementById("optSession");
const fileInput = document.getElementById("fileInput");

const params = new URLSearchParams(window.location.search);
const boundTabId = params.get("tabId") ? Number(params.get("tabId")) : null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "err" : "";
}

function formatBytes(str) {
  const bytes = new Blob([str]).size;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

async function getActiveTab() {
  const tab = boundTabId
    ? await chrome.tabs.get(boundTabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error("Chỉ hoạt động trên trang web http:// hoặc https://");
  }
  return tab;
}

async function getCookieStoreId(tabId) {
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find((s) => s.tabIds.includes(tabId));
  return store ? store.id : undefined;
}

// EXPORT
async function exportData() {
  const tab = await getActiveTab();
  const storeId = await getCookieStoreId(tab.id);
  const mode = formatMode.value;

  let cookies = [];
  if (optCookie.checked || mode === "string") {
    const query = { url: tab.url };
    if (storeId) query.storeId = storeId;
    cookies = await chrome.cookies.getAll(query);
  }

  let storage = {};
  if (mode !== "string" && (optLocal.checked || optSession.checked)) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (getLocal, getSession) => {
        const out = {};
        if (getLocal) out.localStorage = { ...window.localStorage };
        if (getSession) out.sessionStorage = { ...window.sessionStorage };
        return out;
      },
      args: [optLocal.checked, optSession.checked]
    });
    storage = result || {};
  }

  let output = "";

  if (mode === "string") {
    // Dạng chuỗi 1 dòng: name1=val1; name2=val2
    output = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } else if (mode === "compact") {
    // JSON rút gọn: chỉ giữ các thuộc tính khác mặc định
    const compactObj = {};
    if (optCookie.checked) {
      compactObj.c = cookies.map((c) => {
        const item = { n: c.name, v: c.value };
        if (!c.hostOnly && !c.name.startsWith("__Host-") && c.domain) item.d = c.domain;
        if (c.path && c.path !== "/") item.p = c.path;
        if (c.secure) item.s = 1;
        if (c.httpOnly) item.h = 1;
        if (c.sameSite && c.sameSite !== "unspecified") item.ss = c.sameSite;
        return item;
      });
    }
    if (storage.localStorage && Object.keys(storage.localStorage).length) {
      compactObj.l = storage.localStorage;
    }
    if (storage.sessionStorage && Object.keys(storage.sessionStorage).length) {
      compactObj.s = storage.sessionStorage;
    }
    output = JSON.stringify(compactObj);
  } else {
    // JSON đầy đủ
    const fullObj = { url: tab.url, exportedAt: new Date().toISOString() };
    if (optCookie.checked) fullObj.cookies = cookies;
    if (storage.localStorage) fullObj.localStorage = storage.localStorage;
    if (storage.sessionStorage) fullObj.sessionStorage = storage.sessionStorage;
    output = JSON.stringify(fullObj, null, 2);
  }

  dataBox.value = output;
  const lCount = storage.localStorage ? Object.keys(storage.localStorage).length : 0;
  const sCount = storage.sessionStorage ? Object.keys(storage.sessionStorage).length : 0;
  setStatus(`Đã lấy (${formatBytes(output)}): ${cookies.length} cookie${lCount ? `, ${lCount} local` : ""}${sCount ? `, ${sCount} session` : ""}.`);
  return { tab, output, mode };
}

// Chuẩn hóa dữ liệu đầu vào (tự nhận diện 3 định dạng)
function parseInput(raw, tabUrl) {
  let cookies = [];
  let localStorage = null;
  let sessionStorage = null;

  if (raw.startsWith("{") || raw.startsWith("[")) {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      cookies = parsed;
    } else if (parsed.c || parsed.l || parsed.s) {
      // Định dạng JSON rút gọn
      if (Array.isArray(parsed.c)) {
        cookies = parsed.c.map((item) => ({
          name: item.n,
          value: item.v,
          domain: item.d,
          hostOnly: !item.d,
          path: item.p || "/",
          secure: Boolean(item.s),
          httpOnly: Boolean(item.h),
          sameSite: item.ss
        }));
      }
      localStorage = parsed.l || null;
      sessionStorage = parsed.s || null;
    } else {
      // Định dạng JSON đầy đủ
      cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
      localStorage = parsed.localStorage || null;
      sessionStorage = parsed.sessionStorage || null;
    }
  } else {
    // Định dạng chuỗi ngắn: name1=val1; name2=val2
    const isHttps = tabUrl.startsWith("https://");
    const pairs = raw.split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      cookies.push({
        name,
        value,
        hostOnly: true,
        path: "/",
        secure: isHttps || name.startsWith("__Secure-") || name.startsWith("__Host-"),
        httpOnly: false
      });
    }
  }

  return { cookies, localStorage, sessionStorage };
}

// IMPORT
async function importData() {
  const tab = await getActiveTab();
  const storeId = await getCookieStoreId(tab.id);
  const raw = dataBox.value.trim();
  if (!raw) throw new Error("Ô dữ liệu đang trống.");

  const { cookies, localStorage, sessionStorage } = parseInput(raw, tab.url);
  let cookieOk = 0;
  let cookieFail = 0;

  if (optCookie.checked && cookies.length > 0) {
    for (const c of cookies) {
      try {
        const cleanDomain = (c.domain || "").replace(/^\./, "");
        const protocol = c.secure ? "https://" : "http://";
        const cookieUrl = cleanDomain
          ? `${protocol}${cleanDomain}${c.path || "/"}`
          : tab.url;

        const details = {
          url: cookieUrl,
          name: c.name,
          value: c.value,
          path: c.path || "/",
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly)
        };

        if (storeId) details.storeId = storeId;
        if (!c.hostOnly && !c.name.startsWith("__Host-") && c.domain) {
          details.domain = c.domain;
        }
        if (c.expirationDate) details.expirationDate = c.expirationDate;
        if (c.sameSite && ["no_restriction", "lax", "strict", "unspecified"].includes(c.sameSite)) {
          details.sameSite = c.sameSite;
        }

        await chrome.cookies.set(details);
        cookieOk++;
      } catch {
        cookieFail++;
      }
    }
  }

  if ((optLocal.checked && localStorage) || (optSession.checked && sessionStorage)) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (localData, sessionData) => {
        if (localData) {
          for (const [k, v] of Object.entries(localData)) {
            window.localStorage.setItem(k, v);
          }
        }
        if (sessionData) {
          for (const [k, v] of Object.entries(sessionData)) {
            window.sessionStorage.setItem(k, v);
          }
        }
      },
      args: [
        optLocal.checked ? localStorage : null,
        optSession.checked ? sessionStorage : null
      ]
    });
  }

  setStatus(`Nhập xong (${cookieOk} cookie OK${cookieFail ? `, ${cookieFail} lỗi` : ""}). Đang tải lại...`);
  chrome.tabs.reload(tab.id);
}

// 1. LẤY
document.getElementById("btnExport").addEventListener("click", async () => {
  try {
    await exportData();
  } catch (err) {
    setStatus("Lỗi Export: " + err.message, true);
  }
});

// 2. COPY
document.getElementById("btnCopy").addEventListener("click", async () => {
  if (!dataBox.value.trim()) {
    setStatus("Chưa có dữ liệu để copy.", true);
    return;
  }
  await navigator.clipboard.writeText(dataBox.value);
  setStatus(`Đã copy (${formatBytes(dataBox.value)}) vào clipboard!`);
});

// 3. NHẬP
document.getElementById("btnImport").addEventListener("click", async () => {
  try {
    await importData();
  } catch (err) {
    setStatus("Lỗi Import: " + err.message, true);
  }
});

// 4. LƯU FILE
document.getElementById("btnSaveFile").addEventListener("click", async () => {
  try {
    let tab;
    let output = dataBox.value.trim();
    let mode = formatMode.value;

    if (!output) {
      const exported = await exportData();
      tab = exported.tab;
      output = exported.output;
      mode = exported.mode;
    } else {
      tab = await getActiveTab();
    }

    const host = new URL(tab.url).hostname.replace(/[^a-z0-9.-]/gi, "_");
    const date = new Date().toISOString().slice(0, 10);
    const isJson = output.startsWith("{") || output.startsWith("[");
    const ext = isJson ? "json" : "txt";
    const mime = isJson ? "application/json" : "text/plain";

    const blob = new Blob([output], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${host}_${date}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);

    setStatus(`Đã tải xuống: ${a.download} (${formatBytes(output)})`);
  } catch (err) {
    setStatus("Lỗi lưu file: " + err.message, true);
  }
});

// 5. CHỌN FILE
document.getElementById("btnLoadFile").addEventListener("click", async () => {
  try {
    if (!boundTabId) {
      const tab = await getActiveTab();
      await chrome.windows.create({
        url: chrome.runtime.getURL(`popup.html?tabId=${tab.id}`),
        type: "popup",
        width: 400,
        height: 410
      });
      window.close();
      return;
    }
    fileInput.value = "";
    fileInput.click();
  } catch (err) {
    setStatus("Lỗi mở file: " + err.message, true);
  }
});

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    dataBox.value = await file.text();
    await importData();
  } catch (err) {
    setStatus("Lỗi đọc file: " + err.message, true);
  }
});

// KÉO THẢ FILE
dataBox.addEventListener("dragover", (e) => {
  e.preventDefault();
  dataBox.classList.add("dragover");
});
dataBox.addEventListener("dragleave", () => {
  dataBox.classList.remove("dragover");
});
dataBox.addEventListener("drop", async (e) => {
  e.preventDefault();
  dataBox.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  try {
    dataBox.value = await file.text();
    await importData();
  } catch (err) {
    setStatus("Lỗi thả file: " + err.message, true);
  }
});

// 6. XÓA SẠCH
document.getElementById("btnClear").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    const storeId = await getCookieStoreId(tab.id);
    let removed = 0;

    if (optCookie.checked) {
      const query = { url: tab.url };
      if (storeId) query.storeId = storeId;
      const cookies = await chrome.cookies.getAll(query);

      for (const c of cookies) {
        const cleanDomain = (c.domain || "").replace(/^\./, "");
        const protocol = c.secure ? "https://" : "http://";
        const cookieUrl = cleanDomain
          ? `${protocol}${cleanDomain}${c.path || "/"}`
          : tab.url;
        const removeDetails = { url: cookieUrl, name: c.name };
        if (storeId) removeDetails.storeId = storeId;
        await chrome.cookies.remove(removeDetails);
        removed++;
      }
    }

    if (optLocal.checked || optSession.checked) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (clearLocal, clearSession) => {
          if (clearLocal) window.localStorage.clear();
          if (clearSession) window.sessionStorage.clear();
        },
        args: [optLocal.checked, optSession.checked]
      });
    }

    dataBox.value = "";
    setStatus(`Đã xóa ${removed} cookie và storage đã chọn. Đang tải lại...`);
    chrome.tabs.reload(tab.id);
  } catch (err) {
    setStatus("Lỗi xóa: " + err.message, true);
  }
});

if (boundTabId) {
  setStatus("Bấm 'Chọn file' lần nữa để chọn file .json hoặc .txt từ máy.");
}