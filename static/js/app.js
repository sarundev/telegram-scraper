// ─── TeleHarvest Dashboard Logic ─────────────────────────────────────────────

const socket = io();

// ─── DOM Elements & State ──────────────────────────────────────────────────
let activePage = "accounts";
let connectedAccounts = [];
let scrapeTasks = []; // list of task IDs
let currentScrapeTaskId = null;
let currentDmTaskId = null;
let currentInviteTaskId = null;

// Page Title Mapping
const PAGE_TITLES = {
  accounts: { title: "Account Manager", subtitle: "Connect and manage your Telegram sessions" },
  scraper: { title: "Group Scraper", subtitle: "Extract members from Telegram groups/channels" },
  sender: { title: "Mass DM Sender", subtitle: "Send marketing campaigns to scraped leads" },
  adder: { title: "Group Member Adder", subtitle: "Invite scraped members to your own group/channel" },
  poster: { title: "Auto-Poster / Forwarder", subtitle: "Forward messages from target channels in real-time" },
  exports: { title: "File Exports", subtitle: "Download harvested lists as CSV" }
};

// ─── Page Navigation ────────────────────────────────────────────────────────
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    const pageId = item.getAttribute("data-page");
    switchPage(pageId);
  });
});

function switchPage(pageId) {
  document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));

  const targetNav = document.querySelector(`[data-page="${pageId}"]`);
  const targetPage = document.getElementById(`page-${pageId}`);

  if (targetNav && targetPage) {
    targetNav.classList.add("active");
    targetPage.classList.add("active");
    activePage = pageId;

    // Update Titles
    document.getElementById("page-title").textContent = PAGE_TITLES[pageId].title;
    document.getElementById("page-subtitle").textContent = PAGE_TITLES[pageId].subtitle;

    // Page-specific initial loads
    if (pageId === "accounts") refreshAccounts();
    if (pageId === "scraper") updateAccountDropdowns();
    if (pageId === "sender") {
      updateAccountDropdowns();
      populateScrapeTasksDropdown();
    }
    if (pageId === "adder") {
      updateAccountDropdowns();
      populateScrapeTasksDropdown();
    }
    if (pageId === "poster") {
      updateAccountDropdowns();
      refreshForwarderTasks();
    }
    if (pageId === "exports") refreshExports();
  }
}

// ─── SocketIO Status Handler ─────────────────────────────────────────────────
socket.on("connect", () => {
  const dot = document.getElementById("socket-status-dot");
  const label = document.getElementById("socket-status-label");
  dot.className = "status-dot connected";
  label.textContent = "Online";
  showToast("Connected to server backend", "success");
});

socket.on("disconnect", () => {
  const dot = document.getElementById("socket-status-dot");
  const label = document.getElementById("socket-status-label");
  dot.className = "status-dot error";
  label.textContent = "Offline";
  showToast("Disconnected from backend", "error");
});

// SocketIO task updates
socket.on("task_update", (data) => {
  const { task_id, status, progress, total, log, sent, failed, csv } = data;

  if (task_id.startsWith("scrape_")) {
    if (task_id === currentScrapeTaskId) {
      updateScrapeProgress(status, progress, total, log, csv);
    }
    // Add to scrape tasks if not present
    if (!scrapeTasks.includes(task_id)) {
      scrapeTasks.push(task_id);
      populateScrapeTasksDropdown();
    }
  } else if (task_id.startsWith("dm_")) {
    if (task_id === currentDmTaskId) {
      updateDmProgress(status, progress, total, log, sent, failed);
    }
  } else if (task_id.startsWith("invite_")) {
    if (task_id === currentInviteTaskId) {
      updateInviteProgress(status, progress, total, log, sent, failed); // Flask returns "sent"/"failed" or "added"/"failed" inside Socket emission. Let's map it cleanly.
    }
  }
});

// SocketIO forwarder logs
socket.on("forward_log", (data) => {
  const { task_id, timestamp, text, status } = data;
  const logBox = document.getElementById("poster-log");
  const logCard = document.getElementById("poster-log-card");
  if (logBox && logCard) {
    logCard.style.display = "block";
    const colorStyle = status === "success" ? "style='color: #34d399; font-weight:500;'" : "style='color: #f87171;'";
    logBox.innerHTML += `<div class="log-entry" ${colorStyle}>[${timestamp}] ${text}</div>`;
    logBox.scrollTop = logBox.scrollHeight;
  }
});

// ─── Toast Notifications ─────────────────────────────────────────────────────
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  
  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  if (type === "error") icon = "❌";

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ─── Accounts Section ────────────────────────────────────────────────────────
async function refreshAccounts() {
  try {
    const res = await fetch("/api/accounts");
    const data = await res.json();
    connectedAccounts = data;
    renderAccountsList(data);
    updateAccountDropdowns();
    document.getElementById("account-count").textContent = data.filter(a => a.status === "connected").length;
  } catch (err) {
    showToast("Failed to fetch accounts", "error");
  }
}

function renderAccountsList(accounts) {
  const list = document.getElementById("accounts-list");
  if (!accounts || accounts.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👤</div>
        <p>No Telegram accounts registered yet</p>
      </div>`;
    return;
  }

  list.innerHTML = accounts.map(acc => `
    <div class="account-card">
      <div class="account-avatar">
        ${(acc.name || acc.phone).substring(0, 2).toUpperCase()}
      </div>
      <div class="account-info">
        <div class="account-name">${acc.name || "Telegram Account"}</div>
        <div class="account-phone">${acc.phone}</div>
        <div class="account-status ${acc.status}">
          ${acc.status === "connected" ? "● Connected" : "● Offline"}
        </div>
      </div>
      <div class="account-actions">
        <button class="btn btn-danger" style="padding: 6px 10px; font-size: 12px;" onclick="deleteAccount('${acc.phone}')">Delete</button>
      </div>
    </div>
  `).join("");
}

function updateAccountDropdowns() {
  const scrapeSelect = document.getElementById("scrape-phone");
  const dmSelect = document.getElementById("dm-phone");
  const adderSelect = document.getElementById("adder-phone");
  const posterSelect = document.getElementById("poster-phone");
  
  const connectedOnly = connectedAccounts.filter(a => a.status === "connected");
  const options = connectedOnly.map(a => `<option value="${a.phone}">${a.name || a.phone} (${a.phone})</option>`).join("");

  if (scrapeSelect) {
    scrapeSelect.innerHTML = options || `<option value="">No accounts connected</option>`;
  }
  if (dmSelect) {
    dmSelect.innerHTML = options || `<option value="">No accounts connected</option>`;
  }
  if (adderSelect) {
    adderSelect.innerHTML = options || `<option value="">No accounts connected</option>`;
  }
  if (posterSelect) {
    posterSelect.innerHTML = options || `<option value="">No accounts connected</option>`;
  }
}

async function sendOTP() {
  const phone = document.getElementById("acc-phone").value.trim();
  const apiId = document.getElementById("acc-api-id").value.trim();
  const apiHash = document.getElementById("acc-api-hash").value.trim();
  const btn = document.getElementById("btn-send-otp");

  if (!phone || !apiId || !apiHash) {
    showToast("Please fill in Phone, API ID and API Hash", "error");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Sending OTP...`;

  try {
    const res = await fetch("/api/accounts/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, api_id: apiId, api_hash: apiHash })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
    } else {
      showToast("OTP sent successfully. Check your Telegram app/SMS.", "success");
      document.getElementById("otp-section").classList.remove("hidden");
    }
  } catch (err) {
    console.error("sendOTP caught exception:", err);
    showToast("Error sending OTP: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Send OTP`;
  }
}

async function verifyOTP() {
  const phone = document.getElementById("acc-phone").value.trim();
  const code = document.getElementById("acc-otp").value.trim();
  const password = document.getElementById("acc-2fa").value.trim();

  if (!code) {
    showToast("Please enter OTP code", "error");
    return;
  }

  try {
    const res = await fetch("/api/accounts/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code, password })
    });
    const data = await res.json();
    if (data.error) {
      if (data.error === "2FA_REQUIRED") {
        showToast("2FA Password is required for this account", "info");
      } else {
        showToast(data.error, "error");
      }
    } else {
      showToast("Account successfully connected!", "success");
      document.getElementById("otp-section").classList.add("hidden");
      document.getElementById("acc-phone").value = "";
      document.getElementById("acc-otp").value = "";
      document.getElementById("acc-2fa").value = "";
      refreshAccounts();
    }
  } catch (err) {
    console.error("verifyOTP caught exception:", err);
    showToast("Verification failed: " + err.message, "error");
  }
}

async function deleteAccount(phone) {
  if (!confirm("Are you sure you want to disconnect and delete this session?")) return;
  try {
    const res = await fetch("/api/accounts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    showToast(data.message || "Account removed", "success");
    refreshAccounts();
  } catch (err) {
    showToast("Error removing account", "error");
  }
}

// ─── Scraper Section ─────────────────────────────────────────────────────────
async function previewGroup() {
  const phone = document.getElementById("scrape-phone").value;
  const groupUrl = document.getElementById("scrape-group").value.trim();
  const btn = document.getElementById("btn-preview-group");
  const infoBox = document.getElementById("group-info-box");

  if (!phone || !groupUrl) {
    showToast("Select a phone account and type group username/URL", "error");
    return;
  }

  btn.disabled = true;
  infoBox.innerHTML = `Loading group metadata...`;
  infoBox.classList.remove("hidden");

  try {
    const res = await fetch("/api/group/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, group_url: groupUrl })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
      infoBox.classList.add("hidden");
    } else {
      infoBox.innerHTML = `
        <div class="info-item"><span class="label">Title</span><span class="value">${data.title || 'N/A'}</span></div>
        <div class="info-item"><span class="label">Username</span><span class="value">@${data.username || 'private'}</span></div>
        <div class="info-item"><span class="label">ID</span><span class="value">${data.id}</span></div>
        <div class="info-item"><span class="label">Type</span><span class="value">${data.type}</span></div>
        <div class="info-item"><span class="label">Members Count</span><span class="value">${data.members_count || 'Unknown'}</span></div>
      `;
    }
  } catch (err) {
    showToast("Failed to fetch group details", "error");
    infoBox.classList.add("hidden");
  } finally {
    btn.disabled = false;
  }
}

async function startScrape() {
  const phone = document.getElementById("scrape-phone").value;
  const groupUrl = document.getElementById("scrape-group").value.trim();
  const limit = document.getElementById("scrape-limit").value;
  const filterVal = document.getElementById("scrape-filter").value;
  const btn = document.getElementById("btn-start-scrape");

  if (!phone || !groupUrl) {
    showToast("Make sure account is chosen and group URL is filled", "error");
    return;
  }

  btn.disabled = true;
  
  try {
    const res = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, group_url: groupUrl, limit, filter: filterVal })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
      btn.disabled = false;
    } else {
      currentScrapeTaskId = data.task_id;
      showToast("Scraping task started successfully", "success");
      
      // UI Reset for progress
      document.getElementById("scrape-progress-card").style.display = "block";
      document.getElementById("scrape-status-title").textContent = "Harvesting members...";
      document.getElementById("scrape-task-badge").className = "task-badge running";
      document.getElementById("scrape-task-badge").textContent = "RUNNING";
      document.getElementById("scrape-progress-fill").style.width = "0%";
      document.getElementById("scrape-progress-text").textContent = "Initializing...";
      document.getElementById("scrape-progress-pct").textContent = "0%";
      document.getElementById("scrape-log").innerHTML = `<div class="log-entry">Task launched. Connecting to Telegram...</div>`;
      
      document.getElementById("btn-export-scrape").disabled = true;
      document.getElementById("btn-use-for-dm").disabled = true;
      
      document.getElementById("members-table-card").style.display = "none";
    }
  } catch (err) {
    showToast("Error initializing scrape task", "error");
    btn.disabled = false;
  }
}

function updateScrapeProgress(status, progress, total, log, csv) {
  const fill = document.getElementById("scrape-progress-fill");
  const text = document.getElementById("scrape-progress-text");
  const pct = document.getElementById("scrape-progress-pct");
  const badge = document.getElementById("scrape-task-badge");
  const title = document.getElementById("scrape-status-title");
  const logBox = document.getElementById("scrape-log");

  const percentage = total > 0 ? Math.round((progress / total) * 100) : 0;
  fill.style.width = `${percentage}%`;
  text.textContent = `${progress} / ${total} members`;
  pct.textContent = `${percentage}%`;

  if (log && log.length > 0 && logBox) {
    logBox.innerHTML = log.map(l => `<div class="log-entry">${l}</div>`).join("");
    logBox.scrollTop = logBox.scrollHeight;
  }

  if (status === "running") {
    badge.className = "task-badge running";
    badge.textContent = "RUNNING";
  } else if (status === "done") {
    badge.className = "task-badge done";
    badge.textContent = "COMPLETED";
    title.textContent = "Scrape completed successfully";
    document.getElementById("btn-start-scrape").disabled = false;
    document.getElementById("btn-export-scrape").disabled = false;
    document.getElementById("btn-use-for-dm").disabled = false;
    
    // Fetch and display members table
    fetchMembersTable(currentScrapeTaskId);
  } else if (status === "error") {
    badge.className = "task-badge error";
    badge.textContent = "FAILED";
    title.textContent = "Task failed";
    document.getElementById("btn-start-scrape").disabled = false;
  }
}

let currentMembersList = [];

async function fetchMembersTable(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/members`);
    currentMembersList = await res.json();
    
    // Reset search input on loading new task results
    const searchInput = document.getElementById("member-search");
    if (searchInput) searchInput.value = "";
    
    renderMembersTable(currentMembersList);
    document.getElementById("members-table-card").style.display = "block";
  } catch (err) {
    showToast("Error retrieving scraping results table", "error");
  }
}

function renderMembersTable(members) {
  const tbody = document.getElementById("members-tbody");
  document.getElementById("member-count-badge").textContent = `${members.length} members`;
  
  if (members.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No members found.</td></tr>`;
  } else {
    tbody.innerHTML = members.map((m, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td class="username-cell">${m.username ? "@" + m.username : "—"}</td>
        <td>${m.first_name || "—"}</td>
        <td>${m.last_name || "—"}</td>
        <td>${m.phone || "—"}</td>
        <td>${m.id}</td>
      </tr>
    `).join("");
  }
}

function filterMembersTable() {
  const query = document.getElementById("member-search").value.toLowerCase().trim();
  if (!query) {
    renderMembersTable(currentMembersList);
    return;
  }
  const filtered = currentMembersList.filter(m => {
    return (m.username && m.username.toLowerCase().includes(query)) ||
           (m.first_name && m.first_name.toLowerCase().includes(query)) ||
           (m.last_name && m.last_name.toLowerCase().includes(query)) ||
           (m.phone && m.phone.includes(query)) ||
           String(m.id).includes(query);
  });
  renderMembersTable(filtered);
}

function exportScrape() {
  if (currentScrapeTaskId) {
    window.location.href = `/api/tasks/${currentScrapeTaskId}/export`;
  }
}

function useForDM() {
  if (currentScrapeTaskId) {
    switchPage("sender");
    // Auto select the task inside DM selection dropdown
    setTimeout(() => {
      document.getElementById("dm-task-id").value = currentScrapeTaskId;
    }, 200);
  }
}

function populateScrapeTasksDropdown() {
  const select = document.getElementById("dm-task-id");
  const adderSelect = document.getElementById("adder-task-id");
  
  if (select) {
    const currentVal = select.value;
    select.innerHTML = `<option value="">— select scrape task —</option>` +
      scrapeTasks.map(t => `<option value="${t}">Scrape Run (${t.split("_")[1]})</option>`).join("");
    if (scrapeTasks.includes(currentVal)) {
      select.value = currentVal;
    }
  }

  if (adderSelect) {
    const currentValAdder = adderSelect.value;
    adderSelect.innerHTML = `<option value="">— select scrape task —</option>` +
      scrapeTasks.map(t => `<option value="${t}">Scrape Run (${t.split("_")[1]})</option>`).join("");
    if (scrapeTasks.includes(currentValAdder)) {
      adderSelect.value = currentValAdder;
    }
  }
}

// ─── Mass DM Section ─────────────────────────────────────────────────────────
async function startDM() {
  const phone = document.getElementById("dm-phone").value;
  const taskId = document.getElementById("dm-task-id").value;
  const delay = document.getElementById("dm-delay").value;
  const message = document.getElementById("dm-message").value.trim();
  const btn = document.getElementById("btn-start-dm");

  if (!phone || !taskId || !message) {
    showToast("All fields are required to start a campaign", "error");
    return;
  }

  btn.disabled = true;

  try {
    const res = await fetch("/api/dm/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, task_id: taskId, delay, message })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
      btn.disabled = false;
    } else {
      currentDmTaskId = data.task_id;
      showToast("Mass DM campaign initiated!", "success");

      // UI setup
      document.getElementById("dm-progress-card").style.display = "block";
      document.getElementById("dm-task-badge").className = "task-badge running";
      document.getElementById("dm-task-badge").textContent = "RUNNING";
      document.getElementById("dm-progress-fill").style.width = "0%";
      document.getElementById("dm-progress-text").textContent = "Preparing queue...";
      document.getElementById("dm-progress-pct").textContent = "0%";
      document.getElementById("dm-sent").textContent = "0";
      document.getElementById("dm-failed").textContent = "0";
      document.getElementById("dm-log").innerHTML = `<div class="log-entry">Task launched. Awaiting first log...</div>`;
    }
  } catch (err) {
    showToast("Failed to launch campaign", "error");
    btn.disabled = false;
  }
}

function updateDmProgress(status, progress, total, log, sent, failed) {
  const fill = document.getElementById("dm-progress-fill");
  const text = document.getElementById("dm-progress-text");
  const pct = document.getElementById("dm-progress-pct");
  const badge = document.getElementById("dm-task-badge");
  const logBox = document.getElementById("dm-log");

  const percentage = total > 0 ? Math.round((progress / total) * 100) : 0;
  fill.style.width = `${percentage}%`;
  text.textContent = `${progress} / ${total} messages processed`;
  pct.textContent = `${percentage}%`;

  document.getElementById("dm-sent").textContent = sent || 0;
  document.getElementById("dm-failed").textContent = failed || 0;

  if (log && log.length > 0) {
    logBox.innerHTML = log.map(l => `<div class="log-entry">${l}</div>`).join("");
    logBox.scrollTop = logBox.scrollHeight;
  }

  if (status === "running") {
    badge.className = "task-badge running";
    badge.textContent = "RUNNING";
  } else if (status === "done") {
    badge.className = "task-badge done";
    badge.textContent = "FINISHED";
    document.getElementById("btn-start-dm").disabled = false;
    showToast("Campaign ended successfully!", "success");
  } else if (status === "error") {
    badge.className = "task-badge error";
    badge.textContent = "STOPPED";
    document.getElementById("btn-start-dm").disabled = false;
    showToast("Campaign terminated due to an error/limit.", "error");
  }
}

// ─── Exports Section ─────────────────────────────────────────────────────────
async function refreshExports() {
  const container = document.getElementById("exports-list");
  try {
    const res = await fetch("/api/exports");
    const data = await res.json();
    
    if (!data || data.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📁</div>
          <p>No export files yet. Run scrapers first!</p>
        </div>`;
      return;
    }

    container.innerHTML = data.map(f => {
      const displaySize = (f.size / 1024).toFixed(1) + " KB";
      return `
        <div class="export-item animate-in">
          <div class="export-info">
            <span class="export-icon">📊</span>
            <div>
              <div class="export-name">${f.name}</div>
              <div class="export-size">${displaySize}</div>
            </div>
          </div>
          <a class="btn btn-secondary" style="padding:6px 12px; font-size:13px;" href="/api/exports/${f.name}">Download</a>
        </div>
      `;
    }).join("");
  } catch (err) {
    showToast("Failed to fetch export files", "error");
  }
}

// ─── Group Adder Section ─────────────────────────────────────────────────────
async function startAdder() {
  const phone = document.getElementById("adder-phone").value;
  const taskId = document.getElementById("adder-task-id").value;
  const delay = document.getElementById("adder-delay").value;
  const targetGroup = document.getElementById("adder-target-group").value.trim();
  const btn = document.getElementById("btn-start-adder");

  if (!phone || !taskId || !targetGroup) {
    showToast("All fields are required to start the adder process", "error");
    return;
  }

  btn.disabled = true;

  try {
    const res = await fetch("/api/invite/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, task_id: taskId, delay, target_group: targetGroup })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
      btn.disabled = false;
    } else {
      currentInviteTaskId = data.task_id;
      showToast("Group member adding campaign initiated!", "success");

      // UI setup
      document.getElementById("adder-progress-card").style.display = "block";
      document.getElementById("adder-task-badge").className = "task-badge running";
      document.getElementById("adder-task-badge").textContent = "RUNNING";
      document.getElementById("adder-progress-fill").style.width = "0%";
      document.getElementById("adder-progress-text").textContent = "Preparing queue...";
      document.getElementById("adder-progress-pct").textContent = "0%";
      document.getElementById("adder-added").textContent = "0";
      document.getElementById("adder-failed").textContent = "0";
      document.getElementById("adder-log").innerHTML = `<div class="log-entry">Task launched. Awaiting logs...</div>`;
    }
  } catch (err) {
    showToast("Failed to launch adding campaign", "error");
    btn.disabled = false;
  }
}

function updateInviteProgress(status, progress, total, log, added, failed) {
  const fill = document.getElementById("adder-progress-fill");
  const text = document.getElementById("adder-progress-text");
  const pct = document.getElementById("adder-progress-pct");
  const badge = document.getElementById("adder-task-badge");
  const logBox = document.getElementById("adder-log");

  const percentage = total > 0 ? Math.round((progress / total) * 100) : 0;
  fill.style.width = `${percentage}%`;
  text.textContent = `${progress} / ${total} members processed`;
  pct.textContent = `${percentage}%`;

  document.getElementById("adder-added").textContent = added || 0;
  document.getElementById("adder-failed").textContent = failed || 0;

  if (log && log.length > 0) {
    logBox.innerHTML = log.map(l => `<div class="log-entry">${l}</div>`).join("");
    logBox.scrollTop = logBox.scrollHeight;
  }

  if (status === "running") {
    badge.className = "task-badge running";
    badge.textContent = "RUNNING";
  } else if (status === "done") {
    badge.className = "task-badge done";
    badge.textContent = "FINISHED";
    document.getElementById("btn-start-adder").disabled = false;
    showToast("Adding campaign completed!", "success");
  } else if (status === "error") {
    badge.className = "task-badge error";
    badge.textContent = "STOPPED";
    document.getElementById("btn-start-adder").disabled = false;
    showToast("Adding campaign stopped due to an error/limit.", "error");
  }
}

// ─── Auto-Poster Section ─────────────────────────────────────────────────────
async function startPoster() {
  const phone = document.getElementById("poster-phone").value;
  const source = document.getElementById("poster-source").value.trim();
  const target = document.getElementById("poster-target").value.trim();
  const keywords = document.getElementById("poster-keywords").value.trim();
  const exclude = document.getElementById("poster-exclude").value.trim();
  const replaceFind = document.getElementById("poster-replace-find").value.trim();
  const replaceWith = document.getElementById("poster-replace-with").value.trim();
  const replaceFind2 = document.getElementById("poster-replace-find-2").value.trim();
  const replaceWith2 = document.getElementById("poster-replace-with-2").value.trim();
  const btn = document.getElementById("btn-start-poster");

  if (!phone || !source || !target) {
    showToast("Account, Source, and Target are required to start poster", "error");
    return;
  }

  btn.disabled = true;

  try {
    const res = await fetch("/api/forwarder/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone,
        source,
        target,
        keywords,
        exclude,
        replace_find: replaceFind,
        replace_with: replaceWith,
        replace_find_2: replaceFind2,
        replace_with_2: replaceWith2
      })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
    } else {
      showToast("Real-time forwarder started!", "success");
      document.getElementById("poster-source").value = "";
      document.getElementById("poster-target").value = "";
      document.getElementById("poster-keywords").value = "";
      document.getElementById("poster-exclude").value = "";
      document.getElementById("poster-replace-find").value = "";
      document.getElementById("poster-replace-with").value = "";
      document.getElementById("poster-replace-find-2").value = "";
      document.getElementById("poster-replace-with-2").value = "";
      
      // Make log view visible
      document.getElementById("poster-log-card").style.display = "block";
      document.getElementById("poster-log").innerHTML = `<div class="log-entry" style="color:#94a3b8;">Forwarder task ${data.task_id} launched. Listening to new messages...</div>`;
      
      refreshForwarderTasks();
    }
  } catch (err) {
    showToast("Error starting forwarder task", "error");
  } finally {
    btn.disabled = false;
  }
}

async function refreshForwarderTasks() {
  const container = document.getElementById("active-forwarders-list");
  try {
    const res = await fetch("/api/forwarder/tasks");
    const data = await res.json();

    if (!data || data.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <p>No active message forwarders running</p>
        </div>`;
      return;
    }

    container.innerHTML = data.map(t => {
      const editInfo1 = t.replace_find ? ` | Edit 1: "${t.replace_find}" ➔ "${t.replace_with}"` : "";
      const editInfo2 = t.replace_find_2 ? ` | Edit 2: "${t.replace_find_2}" ➔ "${t.replace_with_2}"` : "";
      return `
        <div class="export-item animate-in">
          <div class="export-info" style="gap:20px;">
            <span style="font-size:24px;">🔄</span>
            <div style="flex:1;">
              <div class="export-name" style="font-size:15px; font-weight:600;">
                Source: <span style="color:var(--accent-primary);">${t.source}</span> ➜ Target: <span style="color:var(--accent-success);">${t.target}</span>
              </div>
              <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
                Account: ${t.phone} | Keywords: ${t.keywords || 'none'} | Exclude: ${t.exclude || 'none'}${editInfo1}${editInfo2}
              </div>
            </div>
          </div>
          <button class="btn btn-danger" style="padding:6px 12px; font-size:13px;" onclick="stopPoster('${t.task_id}')">Stop</button>
        </div>
      `;
    }).join("");
  } catch (err) {
    showToast("Failed to fetch running forwarder tasks", "error");
  }
}

async function stopPoster(taskId) {
  if (!confirm("Stop this message forwarder?")) return;
  try {
    const res = await fetch("/api/forwarder/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId })
    });
    const data = await res.json();
    showToast(data.message || "Forwarder stopped", "success");
    refreshForwarderTasks();
  } catch (err) {
    showToast("Failed to stop forwarder", "error");
  }
}

// ─── Document Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  refreshAccounts();
});
